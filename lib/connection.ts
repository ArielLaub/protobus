import * as amqplib from 'amqplib';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import Config from './config';
import { Logger, redactUrl } from './logger';
import {
    PublishNackedError,
    UnroutableError,
    PublishConfirmTimeoutError,
    ChannelClosedError,
    safeErrorSummary,
} from './errors';

export class AlreadyConnectedError extends Error {}
export class TimeoutError extends Error {}
export class ReconnectionError extends Error {}

/**
 * Publish bookkeeping for a single channel.
 *
 * `returned` holds messageIds the broker bounced back as unroutable; a
 * mandatory publish consults it when its confirm arrives, since RabbitMQ
 * returns first and confirms second.
 */
interface ChannelPublishState {
    returned: Set<string>;
    /** Reject callbacks for publishes still awaiting a confirm. */
    pending: Set<(err: Error) => void>;
    inFlight: number;
    /** Publishes parked on the outstanding-confirm bound. */
    waiters: Array<() => void>;
}

export type Channel = amqplib.Channel;
export type ConsumeOptions = amqplib.Options.Consume;
export type PublishOptions = amqplib.Options.Publish;
export type AssertQueueOptions = amqplib.Options.AssertQueue;
export type AssertExchangeOptions = amqplib.Options.AssertExchange;

/**
 * Result a {@link MessageHandler} can return:
 *  - `Buffer`                          → a single unary reply is published
 *  - `void` / `undefined`              → no reply (one-way event or suppressed)
 *  - `AsyncIterable<Buffer>`           → streaming reply; each yielded chunk
 *                                        is published with x-protobus-final=false,
 *                                        the last one with x-protobus-final=true.
 *
 * See `docs/advanced/streaming.md` for the protocol contract.
 */
export type MessageHandlerResult = Buffer | void | AsyncIterable<Buffer>;

/**
 * Extra context handed to a message handler.
 *
 * `signal` aborts when the processing timeout elapses. A handler doing long or
 * cancellable work should watch it — JavaScript cannot preempt a running
 * function, so the timeout can only stop the framework from acting on a late
 * result. It cannot stop the handler itself unless the handler cooperates.
 */
export interface MessageHandlerContext {
    signal: AbortSignal;
    routingKey: string;
    /**
     * Stable across every redelivery and every retry hop of the same logical
     * message, which is what makes deduplication possible: an ambiguous
     * publish outcome can leave two copies on the bus, and this is the only
     * thing that identifies them as one. Undefined only for a message
     * published by something that did not set it.
     */
    messageId?: string;
    /** The broker has delivered this message before. */
    redelivered: boolean;
}

export type MessageHandler = (
    content: Buffer,
    correlationId: string,
    headers?: Record<string, any>,
    context?: MessageHandlerContext,
) => Promise<MessageHandlerResult>;

export interface ConsumeRetryOptions {
    maxRetries: number;
    retryQueueName: string;
    /**
     * Topic exchange the retry queue is bound to with `#`. We publish to
     * this exchange (not sendToQueue) so the message's routing key stays
     * set to the original `REQUEST.<service>.<method>`. That's what makes
     * the post-TTL DLX redelivery route correctly to the main queue.
     * When absent we fall back to sendToQueue() — which works for unary
     * tests not relying on redelivery, but redelivery WILL silently drop.
     */
    retryExchangeName?: string;
    dlqName: string;
    isHandledError?: (error: unknown) => boolean;
}

export interface ReconnectionOptions {
    maxRetries?: number;          // Max reconnection attempts (default: 10, 0 = infinite)
    initialDelayMs?: number;      // Initial delay before first retry (default: 1000)
    maxDelayMs?: number;          // Maximum delay between retries (default: 30000)
    backoffMultiplier?: number;   // Multiplier for exponential backoff (default: 2)
}

const DEFAULT_RECONNECTION_OPTIONS: Required<ReconnectionOptions> = {
    maxRetries: 10,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
};

export interface IConnection extends EventEmitter {
    isConnected: boolean;
    isReconnecting: boolean;

    connect(url: string, reconnectionOptions?: ReconnectionOptions): Promise<amqplib.ChannelModel>;
    disconnect(): Promise<any>;
    openChannel(): Promise<Channel>;
    closeChannel(channel: Channel): Promise<any>;
    declareExchange(channel: Channel, exchange: string, type: string, options: AssertExchangeOptions): Promise<any>;
    declareQueue(channel: Channel, queueName: string, options: AssertQueueOptions): Promise<any>;
    bindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any>;
    unbindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any>;
    deleteQueue(channel: Channel, queueName: string): Promise<any>;
    ack(channel: Channel, message: amqplib.Message, upTo?: boolean): Promise<any>;
    reject(channel: Channel, message: amqplib.Message, requeue?: boolean): Promise<any>;
    consume(channel: Channel, queueName: string, messageHandler: MessageHandler, options: ConsumeOptions, lateAck: boolean, retryOptions?: ConsumeRetryOptions, processingTimeoutMs?: number): Promise<any>;
    cancel(channel: Channel, consumerTag: string): Promise<any>;
    purgeQueue(channel: Channel, queueName: string): Promise<any>;
    publish(channel: Channel, exchangeName: string, routingKey: string, content: Buffer, properties: PublishOptions): Promise<any>;
    /**
     * Optional so that an existing custom IConnection implementation still
     * satisfies the interface. Callers must treat its absence as "cancellation
     * unsupported" rather than assuming it is there.
     */
    cancelStream?(correlationId: string): boolean;

    // Events: 'reconnecting', 'reconnected', 'disconnected', 'error'
}

export default class Connection extends EventEmitter implements IConnection {
    private handle: amqplib.ChannelModel;
    private url: string;
    private reconnectionOptions: Required<ReconnectionOptions>;
    private reconnectAttempts: number = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private manualDisconnect: boolean = false;
    /** In-flight connect shared by concurrent callers; see _connect(). */
    private connectPromise: Promise<amqplib.ChannelModel> | undefined = undefined;
    /**
     * Bumped by every teardown. A connect completing with a stale generation
     * is obsolete and closes itself rather than installing.
     */
    private generation: number = 0;

    constructor() {
        super();
        // Every listener and dispatcher subscribes to 'reconnected'/'disconnected'
        // on this one emitter, so a handful of services legitimately exceeds
        // Node's default cap of 10 and printed a MaxListenersExceededWarning.
        this.setMaxListeners(0);
    }

    private _isConnected: boolean = false;
    public get isConnected() {
        return this._isConnected;
    }

    private _isReconnecting: boolean = false;
    public get isReconnecting() {
        return this._isReconnecting;
    }

    /**
     * Deliveries currently being handled, keyed by correlationId, so a caller
     * that abandons a streaming reply can stop the producer.
     */
    private activeDeliveries = new Map<string, Set<{ controller: AbortController; cancelled: boolean }>>();

    /**
     * Stop producing a streaming reply the caller has abandoned.
     *
     * Aborts the handler's AbortSignal and stops publishing anything the
     * generator yields from here on. Cancellation is cooperative: a generator
     * that ignores its signal keeps running to completion, but its output is
     * no longer sent anywhere.
     *
     * @returns true if a matching in-flight delivery was found.
     */
    public cancelStream(correlationId: string): boolean {
        const entries = this.activeDeliveries.get(correlationId);
        if (!entries || entries.size === 0) return false;

        // The same message can legitimately be in flight more than once — a
        // redelivery overlapping its predecessor — and all of them are the
        // caller's stream, so all of them stop.
        for (const entry of entries) {
            entry.cancelled = true;
            entry.controller.abort();
        }
        Logger.debug(`stream ${correlationId} cancelled by the caller`);
        return true;
    }

    /** Deliveries whose handler has not finished settling. */
    private _inFlightDeliveries: number = 0;
    private _drainWaiters: Array<() => void> = [];

    /** How many messages are currently being handled. */
    public get inFlightDeliveries() {
        return this._inFlightDeliveries;
    }

    /**
     * Wait for in-flight handlers to finish, up to `timeoutMs`.
     *
     * Resolves `true` if everything drained, `false` if the deadline passed
     * with work still running. A false return is information for the caller,
     * not an error — shutdown should continue rather than hang forever on one
     * stuck handler.
     */
    public drainInFlight(timeoutMs: number): Promise<boolean> {
        if (this._inFlightDeliveries === 0) return Promise.resolve(true);

        return new Promise<boolean>((resolve) => {
            let done = false;
            const finish = (drained: boolean) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                const i = this._drainWaiters.indexOf(wake);
                if (i >= 0) this._drainWaiters.splice(i, 1);
                resolve(drained);
            };

            const wake = () => finish(true);
            const timer = setTimeout(() => finish(false), timeoutMs);
            if (timer.unref) { timer.unref(); }

            this._drainWaiters.push(wake);
        });
    }

    private _deliveryStarted(): void {
        this._inFlightDeliveries++;
    }

    private _deliveryFinished(): void {
        this._inFlightDeliveries--;
        if (this._inFlightDeliveries <= 0) {
            this._inFlightDeliveries = 0;
            const waiters = this._drainWaiters;
            this._drainWaiters = [];
            waiters.forEach((wake) => wake());
        }
    }

    async connect(url: string, reconnectionOptions?: ReconnectionOptions): Promise<amqplib.ChannelModel> {
        if (this.isConnected) throw new AlreadyConnectedError();

        this.url = url;
        this.reconnectionOptions = { ...DEFAULT_RECONNECTION_OPTIONS, ...reconnectionOptions };
        this.manualDisconnect = false;

        return this._connect();
    }

    /**
     * Single-flight connect.
     *
     * Concurrent callers share one attempt, so overlapping connect() calls
     * cannot each open a socket and leave the loser orphaned with no reference
     * left to close it. The reconnect timer shares the gate, so a manual
     * connect() racing an automatic retry cannot double up either.
     */
    private _connect(): Promise<amqplib.ChannelModel> {
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = this._doConnect();
        // Clear the gate however it settles, without altering the result.
        this.connectPromise.then(
            () => { this.connectPromise = undefined; },
            () => { this.connectPromise = undefined; },
        );
        return this.connectPromise;
    }

    private async _doConnect(): Promise<amqplib.ChannelModel> {
        Logger.info('connecting to bus - ' + redactUrl(this.url));

        // Anything that tears the connection down bumps the generation. A
        // connect that completes afterwards belongs to a previous era and
        // must not install itself.
        const generation = this.generation;

        try {
            const handle = await amqplib.connect(this.url);

            if (generation !== this.generation || this.manualDisconnect) {
                // Torn down while this attempt was in flight. Clearing the
                // reconnect timer cannot stop an attempt that has already
                // fired, so the check has to happen here.
                Logger.info('discarding a connection that completed after disconnect');
                try {
                    await handle.close();
                } catch (closeErr: any) {
                    Logger.debug(`failed closing a superseded connection: ${closeErr?.message || closeErr}`);
                }
                throw new ReconnectionError('connection was torn down while connecting');
            }

            this.handle = handle;
            this._isConnected = true;
            this._isReconnecting = false;
            this.reconnectAttempts = 0;

            // Set up connection event handlers
            this.handle.on('error', (err) => {
                Logger.error(`connection error: ${err.message}`);
                this.emit('error', err);
            });

            this.handle.on('close', () => {
                if (this.manualDisconnect) {
                    Logger.info('connection closed (manual disconnect)');
                    return;
                }

                Logger.warn('connection closed unexpectedly');
                this._isConnected = false;
                this.emit('disconnected');
                this._scheduleReconnect();
            });

            Logger.info('connected to message bus');
            return this.handle;
        } catch (err) {
            Logger.error(`failed to connect: ${err.message}`);
            this._isConnected = false;
            throw err;
        }
    }

    private _scheduleReconnect(): void {
        if (this.manualDisconnect) return;
        if (this._isReconnecting) return;

        const { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier } = this.reconnectionOptions;

        if (maxRetries > 0 && this.reconnectAttempts >= maxRetries) {
            const error = new ReconnectionError(`max reconnection attempts (${maxRetries}) exceeded`);
            Logger.error(error.message);
            this.emit('error', error);
            return;
        }

        this._isReconnecting = true;
        this.reconnectAttempts++;

        // Exponential backoff with jitter
        const baseDelay = Math.min(
            initialDelayMs * Math.pow(backoffMultiplier, this.reconnectAttempts - 1),
            maxDelayMs
        );
        const jitter = Math.random() * 0.3 * baseDelay; // Up to 30% jitter
        const delay = Math.floor(baseDelay + jitter);

        Logger.info(`scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
        this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

        this.reconnectTimer = setTimeout(async () => {
            // Read the counter before connecting: a successful _connect resets
            // it to zero.
            const attempt = this.reconnectAttempts;
            try {
                await this._connect();
                Logger.info(`reconnection successful after ${attempt} attempts`);
                this.emit('reconnected');
            } catch (err) {
                if (this.manualDisconnect) {
                    // Torn down deliberately while this attempt was in flight;
                    // not a failure worth reporting or retrying.
                    this._isReconnecting = false;
                    return;
                }
                Logger.error(`reconnection attempt ${attempt} failed: ${err.message}`);
                this._isReconnecting = false;
                this._scheduleReconnect();
            }
        }, delay);

        // Don't block Node from exiting if this is the only pending timer
        if (this.reconnectTimer.unref) {
            this.reconnectTimer.unref();
        }
    }

    async disconnect(): Promise<any> {
        this.manualDisconnect = true;
        // Invalidate any connect already past its timer: clearing the timer
        // below only stops attempts that have not fired yet.
        this.generation++;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this._isReconnecting = false;

        if (this.handle) {
            await this.handle.close();
        }
        this._isConnected = false;
        return;
    }

    /**
     * Open a CONFIRM channel.
     *
     * A plain channel gives the publisher no way to learn whether RabbitMQ
     * accepted a message — `channel.publish()` only reports whether amqplib
     * buffered the bytes locally. See the publish() contract below.
     */
    async openChannel(): Promise<Channel> {
        return this.handle.createConfirmChannel() as unknown as Channel;
    }

    async closeChannel(channel: Channel): Promise<any> {
        return channel.close();
    }

    async declareExchange(channel: Channel, exchange: string, type: string, options: AssertExchangeOptions): Promise<any> {
        return channel.assertExchange(exchange, type, options);
    }

    async declareQueue(channel: Channel, queueName: string, options: AssertQueueOptions): Promise<any> {
        const result = await channel.assertQueue(queueName, options);
        return result.queue;
    }

    async bindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any> {
        return channel.bindQueue(queue, exchange, routingKey, args);
    }

    async unbindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any> {
        return channel.unbindQueue(queue, exchange, routingKey, args);
    }

    async deleteQueue(channel: Channel, queueName: string): Promise<any> {
        return channel.deleteQueue(queueName);
    }

    async ack(channel: Channel, message: amqplib.Message, upTo?: boolean): Promise<any> {
        return channel.ack(message, upTo);
    }

    async reject(channel: Channel, message: amqplib.Message, requeue?: boolean): Promise<any> {
        return channel.reject(message, requeue);
    }

    async consume(
        channel: Channel,
        queueName: string,
        messageHandler: MessageHandler,
        options: ConsumeOptions,
        lateAck: boolean,
        retryOptions?: ConsumeRetryOptions,
        processingTimeoutMs?: number,
    ): Promise<any> {
        const onMessage = async (msg: amqplib.ConsumeMessage | null) => {
            // amqplib delivers null when the broker cancels the consumer
            // (queue deleted, for example). Dereferencing it crashed the process.
            if (!msg) {
                Logger.warn(`consumer for ${queueName} was cancelled by the broker`);
                return;
            }

            const replyTo = msg.properties.replyTo;
            const correlationId = msg.properties.correlationId;
            const headers = msg.properties.headers || {};
            const retryCount = (headers['x-retry-count'] as number) || 0;
            const originalRoutingKey = (headers['x-original-routing-key'] as string) || msg.fields.routingKey;

            Logger.debug(`incoming message: ${JSON.stringify(msg.fields)}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

            if (!options.noAck && !lateAck) { // early ackers never reject and immidiately ack
                await this.ack(channel, msg);
            }

            // NOTE: do NOT use `new Promise(async (resolve, reject) => {...})`
            // — async-executor rejections are invisible to the outer Promise
            // constructor, which swallows handler errors and leaves the
            // retry/DLQ path below as dead code. A plain try/catch propagates
            // errors to the catch arm.
            //
            // The handler is raced against the timer rather than checked after
            // it returns, so a hung handler is actually interrupted and a
            // handler that merely runs long does not have its successful result
            // discarded. The AbortSignal lets a cooperative handler stop.
            const limit = processingTimeoutMs ?? Config.messageProcessingTimeout;
            const controller = new AbortController();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            // This attempt's cancellation state; cleaned up by the caller below.
            let delivery: { controller: AbortController; cancelled: boolean } | undefined;

            try {
                const expiry = new Promise<never>((_resolve, rejectTimeout) => {
                    timeout = setTimeout(() => {
                        controller.abort();
                        rejectTimeout(new TimeoutError(
                            `message ${correlationId} exceeded the ${limit}ms processing timeout`,
                        ));
                    }, limit);
                    // unref: this timer must never be the reason the process
                    // stays alive. The default limit is 10 minutes, so a
                    // ref'd timer held a finished process open for that long.
                    if (timeout.unref) { timeout.unref(); }
                });

                // Registered for the whole delivery so cancelStream() can reach
                // the handler's signal at any point, including before the
                // generator has produced anything.
                delivery = { controller, cancelled: false };
                let group = this.activeDeliveries.get(correlationId);
                if (!group) {
                    group = new Set();
                    this.activeDeliveries.set(correlationId, group);
                }
                group.add(delivery);

                const result = await Promise.race([
                    messageHandler(msg.content, correlationId, headers, {
                        signal: controller.signal,
                        routingKey: msg.fields.routingKey,
                        messageId: msg.properties.messageId,
                        redelivered: msg.fields.redelivered === true,
                    }),
                    expiry,
                ]);
                clearTimeout(timeout);

                // The reply is published before the request is settled, so
                // the worst case is a redelivered request (at-least-once, which
                // the retry/DLQ path already assumes) rather than a settled
                // request whose reply was never sent.
                if (replyTo) {
                    // Streaming reply: handler returned an AsyncIterable<Buffer>.
                    // Each chunk is published to replyTo with x-protobus-final
                    // headers; see docs/advanced/streaming.md.
                    if (result && !Buffer.isBuffer(result) && typeof (result as any)[Symbol.asyncIterator] === 'function') {
                        await this._publishStreamReply(
                            channel, replyTo, correlationId, result as AsyncIterable<Buffer>,
                            () => delivery?.cancelled === true,
                        );
                    } else if (Buffer.isBuffer(result)) {
                        // Unary reply (current behavior)
                        const p = {
                            contentType: 'application/octet-stream',
                            correlationId,
                        };
                        await this.publish(channel, Config.callbacksExchangeName, replyTo, result, p);
                    }
                }
                if (!options.noAck && lateAck) { // late ackers ack once the reply is away
                    await this.ack(channel, msg);
                }
            } catch (err: any) {
                // clear timeout so we don't get 2 errors for the same message
                clearTimeout(timeout);

                // A cancelled delivery is a normal outcome: the caller asked to
                // stop. Settle it so it is neither retried nor dead-lettered.
                if (delivery?.cancelled) {
                    Logger.debug(`message ${correlationId} ended because its stream was cancelled`);
                    if (!options.noAck && lateAck) {
                        await this.ack(channel, msg);
                    }
                    return;
                }
                Logger.error(`unhandled error consuming bus message - ${err.message || err}:\n${err.stack}`);

                // If MessageService pre-encoded the error as a ResponseContainer
                // (via the __PROTOBUS_RESPONSE_BUFFER symbol), we use it to
                // reply to the caller on terminal paths (DLQ / no-retry-config).
                // See message_service.ts handleUnaryError for the contract.
                const errorReplyBuffer: Buffer | undefined = (err as any)?.__PROTOBUS_RESPONSE_BUFFER;
                const publishErrorReply = async () => {
                    if (replyTo && errorReplyBuffer) {
                        await this.publish(channel, Config.callbacksExchangeName, replyTo, errorReplyBuffer, {
                            contentType: 'application/octet-stream',
                            correlationId,
                        });
                    }
                };

                if (!options.noAck && lateAck) {
                    // Check if retry is configured and error is retryable
                    const isHandled = retryOptions?.isHandledError?.(err) ?? false;

                    if (retryOptions && !isHandled && retryOptions.maxRetries > 0) {
                        // Retry logic for unhandled errors
                        if (retryCount < retryOptions.maxRetries) {
                            // Park the message on the retry queue for delayed
                            // redelivery. We publish to the retry EXCHANGE with
                            // the original routing key so the message's
                            // routing key is preserved across the queue → TTL
                            // expiry → DLX → main exchange round-trip. Without
                            // that, the redelivery's routing key would be the
                            // retry queue name and the main queue's binding
                            // wouldn't match — see message_listener.ts.
                            //
                            // The caller stays parked: no reply published here.
                            const newRetryCount = retryCount + 1;
                            Logger.warn(`retrying message ${correlationId} (attempt ${newRetryCount}/${retryOptions.maxRetries})`);

                            const retryHeaders = {
                                ...headers,
                                'x-retry-count': newRetryCount,
                                'x-original-routing-key': originalRoutingKey,
                                'x-first-failure-time': headers['x-first-failure-time'] || Date.now(),
                                'x-last-error': safeErrorSummary(err),
                            };

                            if (retryOptions.retryExchangeName) {
                                // Preferred path: routing-key-preserving publish.
                                await this.publish(
                                    channel,
                                    retryOptions.retryExchangeName,
                                    originalRoutingKey,
                                    msg.content,
                                    {
                                        persistent: true,
                                        correlationId,
                                        // Carried through so the retried copy
                                        // is recognisable as the same logical
                                        // message. Omitting it minted a fresh
                                        // id per hop, which is precisely when
                                        // a consumer needs the old one.
                                        messageId: msg.properties.messageId,
                                        replyTo,
                                        headers: retryHeaders,
                                    },
                                );
                            } else {
                                // Fallback for legacy callers that didn't wire
                                // a retry exchange. Works for the immediate
                                // first hop; the DLX redelivery will drop.
                                await this.publishToQueue(channel, retryOptions.retryQueueName, msg.content, {
                                    persistent: true,
                                    correlationId,
                                    messageId: msg.properties.messageId,
                                    replyTo,
                                    headers: retryHeaders,
                                });
                            }
                            await this.ack(channel, msg);
                        } else {
                            // Max retries exceeded — terminal failure. Reply to
                            // the caller with the encoded error so they get a
                            // thrown exception instead of timing out, THEN send
                            // the message to the DLQ for ops investigation.
                            Logger.error(`message ${correlationId} exceeded max retries (${retryOptions.maxRetries}), sending to DLQ`);

                            await publishErrorReply();

                            const dlqHeaders = {
                                ...headers,
                                'x-retry-count': retryCount,
                                'x-original-routing-key': originalRoutingKey,
                                'x-original-queue': queueName,
                                'x-first-failure-time': headers['x-first-failure-time'] || Date.now(),
                                'x-dlq-time': Date.now(),
                                'x-last-error': safeErrorSummary(err),
                            };

                            await this.publishToQueue(channel, retryOptions.dlqName, msg.content, {
                                persistent: true,
                                correlationId,
                                messageId: msg.properties.messageId,
                                headers: dlqHeaders,
                            });
                            await this.ack(channel, msg);
                        }
                    } else {
                        // No retry configured (or retries disabled / handled
                        // error). Reply to the caller with the encoded error,
                        // then reject without requeue so we don't loop forever.
                        if (isHandled) {
                            Logger.warn(`handled error for message ${correlationId}, not retrying: ${err.message}`);
                        }
                        await publishErrorReply();
                        Logger.warn(`rejecting message ${correlationId}`);
                        await this.reject(channel, msg, false);
                    }
                } else {
                    // Early-ack (or noAck) consumer: the message was acked before
                    // processing, so retry and DLQ are impossible. The caller must
                    // still be told it failed — otherwise it waits out its whole
                    // RPC timeout for a reply that is never coming.
                    await publishErrorReply();
                }
            } finally {
                // Only this attempt's entry: a concurrent redelivery of the same
                // message has its own, and must keep it.
                if (delivery) {
                    const group = this.activeDeliveries.get(correlationId);
                    group?.delete(delivery);
                    if (group && group.size === 0) { this.activeDeliveries.delete(correlationId); }
                }
            }
        };
        // amqplib does not await the consume callback, so a rejection escaping
        // onMessage would become an unhandled rejection and terminate the
        // process. Settlement publishes (reply, retry, DLQ) and can reject, so
        // that is reachable in normal operation.
        //
        // Swallowing is safe: every path that can throw runs before the ack, so
        // the message stays unacknowledged and the broker redelivers it.
        //
        // The promise is returned rather than dropped — amqplib ignores it, but
        // it keeps the delivery awaitable for callers driving a channel.
        await channel.consume(queueName, (msg) => {
            // Counted for the whole settle so a graceful shutdown waits for
            // the reply/retry/DLQ publish, not just the handler body.
            this._deliveryStarted();
            return onMessage(msg)
                .catch((err: any) => {
                    Logger.error(
                        `failed to settle message on ${queueName}: ${err?.message || err}. ` +
                        'Leaving it unacknowledged for redelivery.',
                    );
                })
                .finally(() => this._deliveryFinished());
        }, options);
    }

    async cancel(channel: Channel, consumerTag: string): Promise<any> {
        return channel.cancel(consumerTag);
    }

    async purgeQueue(channel: Channel, queueName: string): Promise<any> {
        return channel.purgeQueue(queueName);
    }

    /**
     * Per-channel publish bookkeeping. Keyed weakly so a closed channel's
     * state is collectable without an explicit teardown call.
     */
    private publishState = new WeakMap<Channel, ChannelPublishState>();

    /**
     * Lazily attach the per-channel listeners publish() depends on.
     *
     * One 'return' listener per channel, never one per publication: a busy
     * channel would otherwise accumulate thousands of listeners.
     */
    private _publishStateFor(channel: Channel): ChannelPublishState {
        const existing = this.publishState.get(channel);
        if (existing) return existing;

        const state: ChannelPublishState = {
            returned: new Set<string>(),
            pending: new Set<(err: Error) => void>(),
            inFlight: 0,
            waiters: [],
        };
        this.publishState.set(channel, state);

        const emitter = channel as unknown as EventEmitter;
        if (typeof emitter.on === 'function') {
            // RabbitMQ sends basic.return BEFORE the confirm for the same
            // message, so recording the id here is always in time for the
            // confirm callback to consult it.
            emitter.on('return', (msg: any) => {
                const id = msg?.properties?.messageId;
                if (id) state.returned.add(id);
            });

            // A channel closing with confirms outstanding leaves those
            // messages in an UNKNOWN state, which the caller must be told.
            const failAll = (reason: string) => {
                const waiting = [...state.pending];
                state.pending.clear();
                waiting.forEach((rejectFn) => rejectFn(new ChannelClosedError(reason)));
                // Release anyone parked on the in-flight bound, or they hang
                // forever waiting for slots that will never free.
                state.inFlight = 0;
                const parked = state.waiters;
                state.waiters = [];
                parked.forEach((wake) => wake());
            };
            emitter.on('close', () => failAll('channel closed while a publish was awaiting its confirm'));
            emitter.on('error', (err: any) => failAll(
                `channel errored while a publish was awaiting its confirm: ${err?.message || err}`,
            ));
        }

        return state;
    }

    /**
     * Publish and resolve only once RabbitMQ has confirmed the message.
     *
     * A resolved promise means all of:
     *   - the broker positively confirmed the publication (basic.ack);
     *   - it was routed, when `mandatory` asked for routing to be enforced;
     *   - the channel's write buffer has drained, so resolving does not invite
     *     the caller to queue more bytes into a full socket.
     *
     * Everything else is a typed rejection — see PublishError and subclasses.
     * Note the two ambiguous ones: PublishConfirmTimeoutError and
     * ChannelClosedError mean the outcome is UNKNOWN, not failed. Retrying
     * either can duplicate the message, which is why every publish carries a
     * stable `messageId` for consumers to deduplicate on.
     */
    async publish(channel: Channel, exchangeName: string,
      routingKey: string, content: Buffer, properties: PublishOptions): Promise<any> {
        return this._confirmedPublish(
            channel,
            properties,
            content,
            (props, onConfirm) => (channel as any).publish(
                exchangeName, routingKey, content, props, onConfirm,
            ),
            `${exchangeName || '(default)'} -> ${routingKey}`,
        );
    }

    /**
     * sendToQueue with the same confirm guarantee as publish().
     *
     * Used by the retry and DLQ paths, where the original is acknowledged on
     * the strength of the handoff — the case where losing the message means
     * losing its only remaining copy.
     */
    async publishToQueue(channel: Channel, queueName: string,
      content: Buffer, properties: PublishOptions): Promise<any> {
        return this._confirmedPublish(
            channel,
            properties,
            content,
            (props, onConfirm) => (channel as any).sendToQueue(
                queueName, content, props, onConfirm,
            ),
            `queue ${queueName}`,
        );
    }

    private async _confirmedPublish(
        channel: Channel,
        properties: PublishOptions,
        content: Buffer,
        send: (props: PublishOptions, onConfirm: (err: any) => void) => boolean,
        describe: string,
    ): Promise<void> {
        const state = this._publishStateFor(channel);

        // A caller-supplied messageId survives retries, which is what lets a
        // consumer recognise a duplicate after an ambiguous outcome.
        const messageId = (properties as any)?.messageId || randomUUID();
        const props: PublishOptions = { ...properties, messageId };

        // Bound unconfirmed work before touching the channel at all.
        while (state.inFlight >= Config.maxOutstandingConfirms) {
            await new Promise<void>((wake) => state.waiters.push(wake));
        }
        state.inFlight++;

        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                let accepted: boolean | undefined;

                const finish = (err?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    state.pending.delete(onClosed);
                    state.returned.delete(messageId);
                    if (err) { reject(err); } else { resolve(); }
                };

                const timer = setTimeout(() => finish(new PublishConfirmTimeoutError(
                    `no broker confirm for ${describe} within ${Config.publishConfirmTimeoutMs}ms`,
                    messageId,
                )), Config.publishConfirmTimeoutMs);
                if (timer.unref) { timer.unref(); }

                const onClosed = (err: Error) => finish(err);
                state.pending.add(onClosed);

                const onConfirm = (err: any) => {
                    if (err) {
                        // amqplib uses the confirm callback for two different
                        // outcomes (amqplib/lib/channel.js): 'message nacked'
                        // is a broker refusal, 'channel closed' means the
                        // channel went away with the message unconfirmed — an
                        // UNKNOWN outcome, not a failure. Its teardown listener
                        // is registered in the ConfirmChannel constructor and
                        // so always runs before ours, leaving the message text
                        // as the only discriminator here.
                        const text = err?.message || String(err);
                        if (/closed/i.test(text)) {
                            return finish(new ChannelClosedError(
                                `${describe} was unconfirmed when the channel closed`, messageId,
                            ));
                        }
                        return finish(new PublishNackedError(
                            `broker nacked ${describe}: ${text}`, messageId,
                        ));
                    }
                    if (state.returned.has(messageId)) {
                        // Confirmed, but returned first: it reached no queue.
                        return finish(new UnroutableError(
                            `${describe} was confirmed but returned as unroutable`, messageId,
                        ));
                    }
                    if (accepted === false) {
                        // Confirmed, but the local write buffer is still full.
                        const emitter = channel as unknown as EventEmitter;
                        if (typeof emitter.once === 'function') {
                            emitter.once('drain', () => finish());
                            return;
                        }
                    }
                    finish();
                };

                try {
                    accepted = send(props, onConfirm);
                } catch (err: any) {
                    finish(err);
                }
            });
        } finally {
            state.inFlight--;
            const next = state.waiters.shift();
            if (next) { next(); }
        }
    }

    /**
     * Publish a streaming reply: each chunk gets the same correlationId; all
     * chunks but the last carry `x-protobus-final=false`, the last carries
     * `x-protobus-final=true`. If the iterable yields nothing, a single empty
     * terminal message is published so the client iterator ends cleanly.
     *
     * Look-ahead-by-one keeps us from needing an extra empty terminal in the
     * common case where the user's generator yields its final-data chunk last.
     */
    private async _publishStreamReply(
        channel: Channel,
        replyTo: string,
        correlationId: string,
        chunks: AsyncIterable<Buffer>,
        isCancelled: () => boolean = () => false,
    ): Promise<void> {
        const publishOne = async (body: Buffer, seq: number, final: boolean): Promise<void> => {
            await this.publish(channel, Config.callbacksExchangeName, replyTo, body, {
                contentType: 'application/octet-stream',
                correlationId,
                headers: {
                    [Config.HEADER_FINAL]: final,
                    [Config.HEADER_SEQ]: seq,
                },
            });
        };

        let seq = 0;
        let buffered: Buffer | undefined = undefined;

        for await (const chunk of chunks) {
            // A caller that cancelled is not listening. Stop sending, and stop
            // pulling from the generator: `break` runs its `finally` blocks and
            // calls its `return()`, which is how a cooperative producer
            // releases whatever it holds open.
            if (isCancelled()) {
                Logger.debug(`stream ${correlationId} cancelled after ${seq} chunk(s); not publishing further`);
                return;
            }
            if (buffered !== undefined) {
                await publishOne(buffered, seq, false);
                seq++;
            }
            buffered = chunk;
        }

        if (isCancelled()) return;

        if (buffered !== undefined) {
            await publishOne(buffered, seq, true);
        } else {
            // Empty stream — terminal-only marker so the client iterator can stop.
            await publishOne(Buffer.alloc(0), 0, true);
        }
    }
}
