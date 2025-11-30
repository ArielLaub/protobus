import { BaseListener } from './base_listener';
import Config from './config';
import { IConnection, ConsumeRetryOptions } from './connection';
import { RetryOptions, DEFAULT_RETRY_OPTIONS } from './message_service';
import { isHandledError } from './errors';

export interface RetryConfig {
    maxRetries: number;
    retryDelayMs: number;
    messageTtlMs?: number;
}

export default class MessageListener extends BaseListener {
    protected retryConfig: RetryConfig;
    protected dlqName: string;
    protected retryQueueName: string;

    constructor(connection: IConnection, lateAck?: boolean, maxConcurrent?: number, retryOptions?: RetryOptions) {
        super(connection);

        this.exchangeName = Config.busExchangeName;
        this.exchangeType = 'topic';

        this.lateAck = !!lateAck;
        this.maxConcurrent = maxConcurrent || 1;

        this.retryConfig = {
            maxRetries: retryOptions?.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries,
            retryDelayMs: retryOptions?.retryDelayMs ?? DEFAULT_RETRY_OPTIONS.retryDelayMs,
            messageTtlMs: retryOptions?.messageTtlMs,
        };

        // Set queue TTL if configured
        this.messageTtlMs = retryOptions?.messageTtlMs;

        this.dlqName = '';
        this.retryQueueName = '';
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

        // Create retry queue with TTL - messages wait here before being redelivered
        // When TTL expires, messages are routed back to the main exchange
        this.retryQueueName = `${serviceName}.Retry`;
        await this.connection.declareQueue(this.channel, this.retryQueueName, {
            durable: true,
            autoDelete: false,
            exclusive: false,
            arguments: {
                'x-message-ttl': this.retryConfig.retryDelayMs,
                'x-dead-letter-exchange': this.exchangeName,
                // Route back to original routing key
            }
        });
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
