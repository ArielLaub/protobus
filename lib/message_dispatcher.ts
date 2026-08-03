import { randomUUID } from 'crypto';

import { IConnection, Channel, PublishOptions } from './connection';
import Config from './config';
import { Logger } from './logger';
import CallbackListener from './callback_listener';
import { StreamTimeoutError, RpcTimeoutError } from './errors';

export class NotConnectedError extends Error {}
export class DisconnectedError extends Error {
    constructor() {
        super('Connection lost during RPC call');
    }
}

interface CallbackEntry {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * A pending streaming RPC. Replies arrive as multiple messages with the same
 * correlationId; we buffer them on `chunks` (waking any current consumer via
 * `resolveNext`) until x-protobus-final=true triggers `ended = true`.
 */
interface StreamEntry {
    chunks: Buffer[];
    resolveNext?: () => void;
    rejectNext?: (err: Error) => void;
    ended: boolean;
    error?: Error;
}

export interface IMessageDispatcher {
    isInitialized: boolean;
    init(): Promise<any>;
    publish(content: any, routingKey: string, rpc: boolean): Promise<any>;
    publishStreaming(content: Buffer, routingKey: string, idleTimeoutMs?: number): AsyncIterable<Buffer>;
}

/** Tolerantly read the x-protobus-final header across AMQP encodings. */
function parseFinalHeader(headers: Record<string, any> | undefined): boolean {
    if (!headers) return false;
    const v = headers[Config.HEADER_FINAL];
    if (v === undefined || v === null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (Buffer.isBuffer(v)) return v.toString('utf8').toLowerCase() === 'true' || v.toString('utf8') === '1';
    if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
    return Boolean(v);
}

export default class MessageDispatcher implements IMessageDispatcher {
    private connection: IConnection;
    private callbacks: Map<string, CallbackEntry>;
    /**
     * correlationId -> in-flight streaming reply state. Distinct from
     * `callbacks` so a streaming reply for an unrelated unary call can't
     * accidentally resolve the wrong Promise.
     */
    private pendingStreams: Map<string, StreamEntry>;
    private callbackListener: CallbackListener;
    private channel: Channel;

    private _isInitialized: boolean = false;
    public get isInitialized() { return this._isInitialized; }
    private _boundOnReconnected: () => void;
    private _boundOnDisconnected: () => void;

    constructor(connection: IConnection) {
        this.connection = connection;

        this.callbacks = new Map<string, CallbackEntry>();
        this.pendingStreams = new Map<string, StreamEntry>();
        this.callbackListener = new CallbackListener(this.connection);

        // Listen for connection events (store bound refs for proper cleanup)
        this._boundOnReconnected = this._onReconnected.bind(this);
        this._boundOnDisconnected = this._onDisconnected.bind(this);
        this.connection.on('disconnected', this._boundOnDisconnected);
        this.connection.on('reconnected', this._boundOnReconnected);
    }

    /**
     * Called when connection is lost - reject all pending callbacks
     */
    private _onDisconnected(): void {
        Logger.debug('MessageDispatcher: connection lost, rejecting pending callbacks');
        this.channel = undefined;

        // Reject all pending RPC callbacks
        const error = new DisconnectedError();
        for (const [_id, callback] of this.callbacks) {
            if (callback.timer) { clearTimeout(callback.timer); }
            callback.reject(error);
        }
        this.callbacks.clear();

        // Tear down any in-flight streams. Their async iterators will throw
        // on the next iteration, surfacing the disconnect to callers.
        for (const [_id, stream] of this.pendingStreams) {
            stream.error = error;
            stream.ended = true;
            if (stream.rejectNext) {
                const reject = stream.rejectNext;
                stream.resolveNext = undefined;
                stream.rejectNext = undefined;
                reject(error);
            }
        }
        this.pendingStreams.clear();
    }

    /**
     * Called when connection is re-established
     */
    private async _onReconnected(): Promise<void> {
        if (!this._isInitialized) return;

        Logger.info('MessageDispatcher: reconnected, re-initializing channel');

        try {
            this.channel = await this.connection.openChannel();
            // CallbackListener handles its own reconnection via BaseListener
            Logger.info('MessageDispatcher: successfully re-initialized after reconnection');
        } catch (err) {
            Logger.error(`MessageDispatcher: failed to re-initialize after reconnection: ${err.message}`);
        }
    }

    async _onResult(content: any, id: string, headers?: Record<string, any>) {
        // Streaming reply path. Distinguishable from unary because the
        // dispatcher pre-registered the correlationId in pendingStreams when
        // publishStreaming() was called.
        if (this.pendingStreams.has(id)) {
            const stream = this.pendingStreams.get(id)!;
            const isFinal = parseFinalHeader(headers);

            // Empty body on a final-only marker is "end of stream, no extra data" —
            // we don't push it as a chunk, just signal completion.
            const body = content as Buffer;
            if (body && body.length > 0) {
                stream.chunks.push(body);
            }
            if (isFinal) {
                stream.ended = true;
            }
            if (stream.resolveNext) {
                const r = stream.resolveNext;
                stream.resolveNext = undefined;
                stream.rejectNext = undefined;
                r();
            }
            return;
        }

        // Unary reply path (existing behavior)
        if (this.callbacks.has(id)) {
            const callback = this.callbacks.get(id);
            this.callbacks.delete(id);
            if (callback.timer) { clearTimeout(callback.timer); }
            callback.resolve(content);
        }
    }

    async init(): Promise<any> {
        if (this.isInitialized) return;
        this.channel = await this.connection.openChannel();
        await this.callbackListener.init(this._onResult.bind(this));
        await this.callbackListener.start();
        this._isInitialized = true;
    }

    /**
     * @param timeoutMs - How long to wait for a reply before rejecting with
     *   RpcTimeoutError. Defaults to Config.rpcCallTimeoutMs. Ignored when
     *   `rpc` is false, since there is nothing to wait for.
     */
    async publish(content: any, routingKey: string, rpc: boolean, timeoutMs?: number): Promise<Buffer> {
        if (!this.connection.isConnected) throw new NotConnectedError();

        if (rpc !== false) {
            rpc = true;
        }

        const id = randomUUID();
        const properties: PublishOptions = {
            contentType: 'application/octet-stream',
            correlationId: id,
            replyTo: rpc ? this.callbackListener.callbackQueue : undefined,
            deliveryMode: 2, // persistent
        };
        // this is called syncronously and _onResult resolves/rejects it later

        await this.connection.publish(this.channel, Config.busExchangeName, routingKey, content, properties);

        if (!rpc) return; // we are not expecting any result so resolve

        const limit = timeoutMs ?? Config.rpcCallTimeoutMs;

        return new Promise<Buffer>((resolve: any, reject: any) => {
            // Bound the wait. Without this, a request nothing is listening for
            // leaves this promise pending forever and its map entry leaks.
            const timer = setTimeout(() => {
                if (this.callbacks.get(id)?.timer === timer) {
                    this.callbacks.delete(id);
                    reject(new RpcTimeoutError(
                        `no reply for ${routingKey} (correlationId ${id}) within ${limit}ms`,
                    ));
                }
            }, limit);
            if (timer.unref) { timer.unref(); }

            this.callbacks.set(id, { resolve, reject, timer });
        });
    }

    /**
     * Publish a request that expects a streaming reply. Returns an
     * `AsyncIterable<Buffer>` over raw reply-message bodies. Iteration ends
     * when a message arrives with x-protobus-final=true. Raises
     * StreamTimeoutError if no chunk arrives within `idleTimeoutMs`.
     *
     * If the caller breaks out of the iteration, the pending-stream slot is
     * released and the dispatcher stops buffering chunks. The server keeps
     * generating (v1 — server cancellation is on the roadmap), but its
     * subsequent publishes are simply dropped at the dispatcher.
     *
     * See `docs/advanced/streaming.md` for the full protocol.
     */
    publishStreaming(content: Buffer, routingKey: string, idleTimeoutMs?: number): AsyncIterable<Buffer> {
        if (!this.connection.isConnected) throw new NotConnectedError();

        const id = randomUUID();
        const stream: StreamEntry = { chunks: [], ended: false };
        this.pendingStreams.set(id, stream);

        // Capture only what the iterator needs to release on cleanup —
        // no `this` alias (lints clean under @typescript-eslint/no-this-alias).
        const pendingStreams = this.pendingStreams;
        const timeoutMs = idleTimeoutMs ?? Config.streamIdleTimeoutMs;

        const properties: PublishOptions = {
            contentType: 'application/octet-stream',
            correlationId: id,
            replyTo: this.callbackListener.callbackQueue,
            deliveryMode: 2,
        };

        // Fire-and-forget the publish; chunks are routed back by _onResult.
        // If the publish fails we still expose the iterator and let it
        // surface the error on first iteration.
        const publishPromise = this.connection.publish(
            this.channel, Config.busExchangeName, routingKey, content, properties,
        ).catch((err) => {
            stream.error = err;
            stream.ended = true;
            if (stream.rejectNext) {
                const r = stream.rejectNext;
                stream.resolveNext = undefined;
                stream.rejectNext = undefined;
                r(err);
            }
        });

        // Return a real AsyncIterable whose `return()` cleans up on `break`.
        return {
            [Symbol.asyncIterator](): AsyncIterator<Buffer> {
                return {
                    async next(): Promise<IteratorResult<Buffer>> {
                        // Wait for the publish to flush at least once before consuming.
                        await publishPromise;

                        while (true) {
                            if (stream.error) {
                                pendingStreams.delete(id);
                                throw stream.error;
                            }
                            if (stream.chunks.length > 0) {
                                const value = stream.chunks.shift()!;
                                return { value, done: false };
                            }
                            if (stream.ended) {
                                pendingStreams.delete(id);
                                return { value: undefined as any, done: true };
                            }
                            // Park on the next chunk arrival.
                            await new Promise<void>((resolve, reject) => {
                                stream.resolveNext = resolve;
                                stream.rejectNext = reject;
                                const timer = setTimeout(() => {
                                    if (stream.resolveNext === resolve) {
                                        stream.resolveNext = undefined;
                                        stream.rejectNext = undefined;
                                        reject(new StreamTimeoutError(`No streaming chunk received within ${timeoutMs}ms`));
                                    }
                                }, timeoutMs);
                                // Don't let an idle timer hold the event loop.
                                if ((timer as any).unref) (timer as any).unref();
                            });
                        }
                    },

                    async return(): Promise<IteratorResult<Buffer>> {
                        // Caller broke out of the for-await; release the slot.
                        pendingStreams.delete(id);
                        return { value: undefined as any, done: true };
                    },

                    async throw(err): Promise<IteratorResult<Buffer>> {
                        pendingStreams.delete(id);
                        throw err;
                    },
                };
            },
        };
    }

    async close(): Promise<void> {
        this.connection.removeListener('disconnected', this._boundOnDisconnected);
        this.connection.removeListener('reconnected', this._boundOnReconnected);
        delete (this as any)._boundOnDisconnected;
        delete (this as any)._boundOnReconnected;
        await this.callbackListener.close();
    }
}
