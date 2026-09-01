import { BaseListener } from './base_listener';
import Config from './config';
import { IConnection, ConsumeRetryOptions } from './connection';
import { RetryOptions, DEFAULT_RETRY_OPTIONS } from './message_service';
import { isHandledError } from './errors';
import { validateMaxPriority } from './priority';

/**
 * Thrown when the retry queue exists with arguments that differ from what this
 * service is configured for — in practice, a changed `retryDelayMs`.
 */
export class RetryQueueMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RetryQueueMismatchError';
    }
}

export interface RetryConfig {
    maxRetries: number;
    retryDelayMs: number;
    messageTtlMs?: number;
}

export default class MessageListener extends BaseListener {
    protected retryConfig: RetryConfig;
    protected dlqName: string;
    protected retryQueueName: string;
    /**
     * Dedicated topic exchange we publish retried messages to. The retry
     * queue is bound to this with `#`, so the message's routing key is
     * preserved as the original `REQUEST.<service>.<method>`. When the
     * TTL on the retry queue expires, the message dead-letters back to
     * the main bus exchange with that original routing key still attached
     * — which is what makes the main queue's binding match on redelivery.
     *
     * Using sendToQueue() directly would set the routing key to the queue
     * name, breaking redelivery routing.
     */
    protected retryExchangeName: string;

    constructor(
        connection: IConnection,
        lateAck?: boolean,
        maxConcurrent?: number,
        retryOptions?: RetryOptions,
        processingTimeoutMs?: number,
        maxPriority?: number,
    ) {
        super(connection);
        // Validated here, at construction, so a bad value fails before any
        // broker I/O rather than as a 406 that closes the shared channel.
        this.maxPriority = validateMaxPriority(maxPriority);

        this.exchangeName = Config.busExchangeName;
        this.exchangeType = 'topic';

        this.lateAck = !!lateAck;
        this.maxConcurrent = maxConcurrent || 1;
        this.processingTimeoutMs = processingTimeoutMs;

        this.retryConfig = {
            maxRetries: retryOptions?.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries,
            retryDelayMs: retryOptions?.retryDelayMs ?? DEFAULT_RETRY_OPTIONS.retryDelayMs,
            messageTtlMs: retryOptions?.messageTtlMs,
        };

        // Set queue TTL if configured
        this.messageTtlMs = retryOptions?.messageTtlMs;

        this.dlqName = '';
        this.retryQueueName = '';
        this.retryExchangeName = '';
    }

    /**
     * Set up DLQ and retry queue for the service
     * Called during init after the main queue is created
     */
    protected async setupRetryQueues(): Promise<void> {
        if (this.retryConfig.maxRetries <= 0 || this.isAnonymous) {
            // No retry for services with maxRetries=0 or anonymous queues
            return;
        }

        const serviceName = this.configuredQueueName;

        // Create DLQ - messages that have exhausted retries go here
        this.dlqName = `${serviceName}.DLQ`;
        await this.connection.declareQueue(this.channel, this.dlqName, {
            durable: true,
            autoDelete: false,
            exclusive: false,
            arguments: {}
        });

        // Retry queue with TTL — messages park here briefly before being
        // redelivered to the main exchange via DLX.
        this.retryQueueName = `${serviceName}.Retry`;
        try {
            await this.connection.declareQueue(this.channel, this.retryQueueName, {
                durable: true,
                autoDelete: false,
                exclusive: false,
                arguments: {
                    'x-message-ttl': this.retryConfig.retryDelayMs,
                    'x-dead-letter-exchange': this.exchangeName,
                    // No x-dead-letter-routing-key: we want the message's *own*
                    // routing key preserved on DLX, which we ensure by publishing
                    // to the retry exchange below with that key.
                }
            });
        } catch (error) {
            // retryDelayMs becomes the queue's x-message-ttl, and RabbitMQ fixes
            // queue arguments at declare time. Changing retryDelayMs for a
            // service that has already run therefore fails startup with an
            // opaque PRECONDITION_FAILED. Say what actually has to happen.
            if (/PRECONDITION[_-]FAILED/i.test((error as any)?.message ?? '')) {
                throw new RetryQueueMismatchError(
                    `retry queue '${this.retryQueueName}' already exists with different arguments ` +
                    `(most likely a different retryDelayMs — now ${this.retryConfig.retryDelayMs}ms). ` +
                    `RabbitMQ cannot change a queue's x-message-ttl in place: drain and delete the ` +
                    `queue, or keep the original retryDelayMs. Original error: ${(error as any).message}`,
                );
            }
            throw error;
        }

        // Dedicated topic exchange for retried messages. We bind the retry
        // queue here with `#` so any routing key lands in the queue, AND
        // the routing key is preserved on the message — which is what makes
        // the post-TTL DLX redelivery route correctly to the main queue.
        this.retryExchangeName = `${serviceName}.Retry.Exchange`;
        await this.connection.declareExchange(
            this.channel,
            this.retryExchangeName,
            'topic',
            { durable: true, autoDelete: false, internal: false, arguments: {} },
        );
        await this.connection.bindQueue(
            this.channel,
            this.retryQueueName,
            this.retryExchangeName,
            '#',
            {},
        );
    }

    /**
     * Get retry queue name for publishing failed messages
     */
    public getRetryQueueName(): string {
        return this.retryQueueName;
    }

    /**
     * Get DLQ name for publishing exhausted messages
     */
    public getDlqName(): string {
        return this.dlqName;
    }

    /**
     * Get retry configuration
     */
    public getRetryConfig(): RetryConfig {
        return this.retryConfig;
    }

    /**
     * Override to provide retry options for consume
     */
    protected getRetryOptions(): ConsumeRetryOptions | undefined {
        if (this.retryConfig.maxRetries <= 0 || !this.retryQueueName || !this.dlqName) {
            return undefined;
        }
        return {
            maxRetries: this.retryConfig.maxRetries,
            retryQueueName: this.retryQueueName,
            retryExchangeName: this.retryExchangeName,
            dlqName: this.dlqName,
            isHandledError,
        };
    }

    async subscribe(topics: string[] | string) {
        if (typeof topics === 'string') { topics = [topics]; }

        for (const topic of topics) {
            await this.connection.bindQueue(this.channel, this.queueName, this.exchangeName, topic, {});
            this.trackBinding(topic); // Track for reconnection
        }

        // Set up retry queues after main queue bindings
        await this.setupRetryQueues();
    }
}
