import { randomUUID } from 'crypto';

import { IConnection, Channel, PublishOptions, attachRestorer } from './connection';
import Config from './config';
import { Logger } from './logger';
import CallbackListener from './callback_listener';
import {
    StreamTimeoutError,
    RpcTimeoutError,
    StreamBackpressureError,
    StreamSequenceError,
} from './errors';

/** Per-call streaming options. */
export interface StreamOptions {
    /**
     * Cancels the stream when aborted, from anywhere — a Stop button handler,
     * an HTTP request's own `signal` when the client disconnects, a timeout.
     * Breaking out of the `for await` cancels too, but only once the next chunk
     * arrives to resume the loop; a signal takes effect immediately.
     */
    signal?: AbortSignal;
}

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
    /** Running total of `chunks`, so the byte bound is O(1) to check. */
    bufferedBytes: number;
    /**
     * Highest x-protobus-seq accepted so far, or -1 before the first chunk.
     * Undefined stays undefined for peers that send no sequence header.
     */
    lastSeq?: number;
    resolveNext?: () => void;
    rejectNext?: (err: Error) => void;
    ended: boolean;
    error?: Error;
    /**
     * Restart the idle deadline. Called on progress from either side — a
     * chunk arriving, or a chunk being handed to the consumer — so "idle"
     * means the call is genuinely stalled rather than merely slow at one end.
     */
    touch?: () => void;
}

export interface IMessageDispatcher {
    isInitialized: boolean;
    init(): Promise<any>;
    publish(content: any, routingKey: string, rpc: boolean): Promise<any>;
    publishStreaming(content: Buffer, routingKey: string, idleTimeoutMs?: number, options?: StreamOptions): AsyncIterable<Buffer>;
}

/**
 * Read x-protobus-seq, tolerating the same encodings as the final header.
 * Returns undefined when absent or unparseable, which disables validation
 * rather than manufacturing a violation.
 */
function parseSeqHeader(headers: Record<string, any> | undefined): number | undefined {
    if (!headers) return undefined;
    const v = headers[Config.HEADER_SEQ];
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : Number(Buffer.isBuffer(v) ? v.toString('utf8') : v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
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
    private _detachRestorer: () => void;
    private _boundOnDisconnected: () => void;

    constructor(connection: IConnection) {
        this.connection = connection;

        this.callbacks = new Map<string, CallbackEntry>();
        this.pendingStreams = new Map<string, StreamEntry>();
        this.callbackListener = new CallbackListener(this.connection);

        // The channel is restored under the connection's coordination, so a
        // caller reacting to 'reconnected' by publishing finds one waiting.
        this._boundOnDisconnected = this._onDisconnected.bind(this);
        this.connection.on('disconnected', this._boundOnDisconnected);
        this._detachRestorer = attachRestorer(
            this.connection, () => this._restore(), 'MessageDispatcher',
        );
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
     * Reopen the publishing channel.
     *
     * A failure propagates: a dispatcher with no channel cannot publish, so
     * the connection is not usable and the generation should be retried rather
     * than announced. The CallbackListener restores itself, registered
     * separately through BaseListener.
     */
    private async _restore(): Promise<void> {
        if (!this._isInitialized) return;

        Logger.info('MessageDispatcher: reconnected, re-initializing channel');
        this.channel = await this.connection.openChannel();
        Logger.info('MessageDispatcher: successfully re-initialized after reconnection');
    }

    async _onResult(content: any, id: string, headers?: Record<string, any>) {
        // Streaming reply path. Distinguishable from unary because the
        // dispatcher pre-registered the correlationId in pendingStreams when
        // publishStreaming() was called.
        if (this.pendingStreams.has(id)) {
            const stream = this.pendingStreams.get(id)!;
            const isFinal = parseFinalHeader(headers);

            // Sequence validation catches a lost chunk, which would otherwise
            // present as a silently truncated stream. An absent header disables
            // validation: peers that send none are behaving correctly, and a
            // violation must not be inferred from missing information.
            const seq = parseSeqHeader(headers);
            if (seq !== undefined) {
                const expected = stream.lastSeq === undefined ? 0 : stream.lastSeq + 1;

                if (seq < expected) {
                    // Already seen — a broker redelivery, not new data. Dropping
                    // is safe and keeps the stream idempotent.
                    Logger.debug(`stream ${id}: dropping duplicate chunk seq=${seq} (expected ${expected})`);
                    if (isFinal) stream.ended = true;
                    if (stream.resolveNext) {
                        const wake = stream.resolveNext;
                        stream.resolveNext = undefined;
                        stream.rejectNext = undefined;
                        wake();
                    }
                    return;
                }

                if (seq > expected) {
                    stream.error = new StreamSequenceError(
                        `stream ${id} lost at least one chunk: got seq=${seq}, expected ${expected}`,
                    );
                    stream.ended = true;
                    stream.chunks.length = 0;
                    stream.bufferedBytes = 0;
                    if (stream.resolveNext) {
                        const wake = stream.resolveNext;
                        stream.resolveNext = undefined;
                        stream.rejectNext = undefined;
                        wake();
                    }
                    return;
                }

                stream.lastSeq = seq;
            }

            // Empty body on a final-only marker is "end of stream, no extra data" —
            // we don't push it as a chunk, just signal completion.
            const body = content as Buffer;
            if (body && body.length > 0) {
                // Bound the buffer. A server that produces faster than the
                // caller iterates would otherwise grow this array until the
                // process died; failing the stream is recoverable, OOM is not.
                const maxChunks = Config.streamMaxBufferedChunks;
                const maxBytes = Config.streamMaxBufferedBytes;
                const wouldBeBytes = stream.bufferedBytes + body.length;

                if (stream.chunks.length + 1 > maxChunks || wouldBeBytes > maxBytes) {
                    stream.error = new StreamBackpressureError(
                        `stream ${id} exceeded its buffer limit ` +
                        `(${stream.chunks.length + 1} chunks / ${wouldBeBytes} bytes; ` +
                        `limits are ${maxChunks} chunks / ${maxBytes} bytes) — ` +
                        'the consumer is not keeping up with the producer',
                    );
                    stream.ended = true;
                    // Drop the buffer now; the iterator only needs the error.
                    stream.chunks.length = 0;
                    stream.bufferedBytes = 0;
                    if (stream.resolveNext) {
                        const wake = stream.resolveNext;
                        stream.resolveNext = undefined;
                        stream.rejectNext = undefined;
                        wake();
                    }
                    return;
                }

                stream.chunks.push(body);
                stream.bufferedBytes = wouldBeBytes;
                stream.touch?.();
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

    /**
     * Hold a publish until the connection can carry it.
     *
     * A reconnection in progress is something to wait through rather than fail
     * on: the channel is being replaced and will be there shortly, and the
     * alternative is rejecting work for the length of a broker restart.
     * Anything else with no connection is a caller error and is reported at
     * once. An IConnection without whenReady() keeps the old behaviour.
     */
    private async _awaitPublishable(): Promise<void> {
        if (!this.connection.isConnected && !this.connection.isReconnecting) {
            throw new NotConnectedError();
        }
        await this.connection.whenReady?.();
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
        await this._awaitPublishable();

        if (rpc !== false) {
            rpc = true;
        }

        const id = randomUUID();
        const properties: PublishOptions = {
            contentType: 'application/octet-stream',
            correlationId: id,
            replyTo: rpc ? this.callbackListener.callbackQueue : undefined,
            deliveryMode: 2, // persistent
            // An RPC request that routes nowhere means no service is bound to
            // this key — a definite error, and one worth learning immediately
            // as UnroutableError rather than after a full RPC timeout.
            //
            // Deliberately NOT set for events: an event with no subscribers is
            // normal, and making that an error would break fan-out publishing.
            mandatory: rpc,
        };
        if (!rpc) {
            // Nothing to wait for beyond the broker confirming receipt.
            await this.connection.publish(
                this.channel, Config.busExchangeName, routingKey, content, properties,
            );
            return;
        }

        const limit = timeoutMs ?? Config.rpcCallTimeoutMs;

        // Arm the reply callback BEFORE publishing. Publishing waits for a
        // broker confirm, and a fast service can reply while that confirm is
        // still in flight; registering afterwards would let _onResult find no
        // entry for the correlationId and drop the reply.
        const replyPromise = new Promise<Buffer>((resolve: any, reject: any) => {
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

        try {
            await this.connection.publish(
                this.channel, Config.busExchangeName, routingKey, content, properties,
            );
        } catch (err) {
            // The request never made it (nack, unroutable, closed channel), so
            // no reply is coming. Release the slot now rather than leaving it
            // to expire, and surface the publish failure to the caller.
            const pending = this.callbacks.get(id);
            if (pending) {
                clearTimeout(pending.timer);
                this.callbacks.delete(id);
            }
            throw err;
        }

        return replyPromise;
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
    publishStreaming(
        content: Buffer,
        routingKey: string,
        idleTimeoutMs?: number,
        options?: StreamOptions,
    ): AsyncIterable<Buffer> {
        if (!this.connection.isConnected && !this.connection.isReconnecting) {
            throw new NotConnectedError();
        }

        const id = randomUUID();
        const stream: StreamEntry = { chunks: [], bufferedBytes: 0, ended: false };
        this.pendingStreams.set(id, stream);

        // Capture only what the iterator needs to release on cleanup —
        // no `this` alias (lints clean under @typescript-eslint/no-this-alias).
        const pendingStreams = this.pendingStreams;
        const timeoutMs = idleTimeoutMs ?? Config.streamIdleTimeoutMs;

        /**
         * Idle deadline for the whole call, armed here rather than on the
         * first next().
         *
         * A caller that never iterates — an early return, a throw between the
         * call and the loop — otherwise leaves the entry and everything the
         * server sends into it held for the life of the process, with no timer
         * anywhere to release it.
         */
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; } };
        const armIdle = () => {
            clearIdle();
            idleTimer = setTimeout(() => {
                if (stream.ended) return;
                stream.error = new StreamTimeoutError(
                    `No streaming chunk received within ${timeoutMs}ms`,
                );
                stream.ended = true;
                stream.chunks.length = 0;
                stream.bufferedBytes = 0;
                // The producer is still generating for a caller that has
                // stopped listening, so tell it to stop — the same courtesy
                // return() and throw() extend. Without this an abandoned
                // stream ran to completion at the server's expense.
                cancel({ notifyOnly: true });
                const fail = stream.rejectNext;
                stream.resolveNext = undefined;
                stream.rejectNext = undefined;
                if (fail) { fail(stream.error); }
            }, timeoutMs);
            if (idleTimer.unref) { idleTimer.unref(); }
        };
        stream.touch = armIdle;

        /** Everything this call holds, released on any terminal outcome. */
        const releaseCall = () => {
            clearIdle();
            releaseSignal();
            pendingStreams.delete(id);
        };

        // Cancellation is BEST EFFORT and delivered at most once. The notice is
        // an ordinary message: if it is lost, the producer never hears it and
        // runs to completion, which is the same outcome as never cancelling.
        // A caller that must be certain the producer stopped should observe
        // that chunks are still arriving and cancel again. See
        // docs/advanced/streaming.md.
        let cancelled = false;

        /**
         * Stop the producer and release everything this call holds.
         *
         * `notifyOnly` is for the idle path, which has already recorded the
         * error the iterator is about to raise and must not have it erased.
         */
        const cancel = (opts: { notifyOnly?: boolean } = {}) => {
            if (cancelled) return;
            cancelled = true;
            clearIdle();
            releaseSignal();
            pendingStreams.delete(id);
            if (!opts.notifyOnly) {
                stream.chunks.length = 0;
                stream.bufferedBytes = 0;
                stream.ended = true;
            }

            Logger.debug(`cancelling stream ${id}`);
            // Fire-and-forget: the caller has already stopped waiting, so there
            // is nothing useful to do with a failure here beyond recording it.
            this.connection.publish(this.channel, Config.cancelExchangeName, '', Buffer.alloc(0), {
                correlationId: id,
                contentType: 'application/octet-stream',
            }).catch((err) => {
                Logger.debug(`failed to publish cancel for stream ${id}: ${err?.message || err}`);
            });
        };

        // An abort listener outlives the call unless it is taken off again:
        // one long-lived signal reused across many calls accumulates one per
        // call, each holding its StreamEntry alive.
        let releaseSignal = () => { /* nothing attached */ };
        const onAbort = () => cancel();

        const abortedBeforeStart = options?.signal?.aborted === true;
        if (options?.signal && !abortedBeforeStart) {
            const signal = options.signal;
            signal.addEventListener('abort', onAbort, { once: true });
            releaseSignal = () => { signal.removeEventListener('abort', onAbort); };
        }

        if (abortedBeforeStart) {
            // Aborted before it began: nothing to send and nothing to wait for.
            stream.ended = true;
            pendingStreams.delete(id);
        } else {
            armIdle();
        }

        const properties: PublishOptions = {
            contentType: 'application/octet-stream',
            correlationId: id,
            replyTo: this.callbackListener.callbackQueue,
            deliveryMode: 2,
        };

        // Fire-and-forget the publish; chunks are routed back by _onResult.
        // If the publish fails we still expose the iterator and let it
        // surface the error on first iteration.
        //
        // The channel is read after readiness, not before: a reconnection
        // replaces it, and capturing the old one here would publish onto a
        // channel that is already gone.
        const publishPromise = abortedBeforeStart
            ? Promise.resolve()
            : Promise.resolve()
                .then(() => this.connection.whenReady?.())
                .then(() => this.connection.publish(
                    this.channel, Config.busExchangeName, routingKey, content, properties,
                ))
            .catch((err) => {
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
                                // A rejecting next() does not cause the runtime
                                // to call return() or throw(), so this is the
                                // only chance to let go of what the call holds.
                                releaseCall();
                                throw stream.error;
                            }
                            if (stream.chunks.length > 0) {
                                const value = stream.chunks.shift()!;
                                stream.bufferedBytes -= value.length;
                                armIdle();
                                return { value, done: false };
                            }
                            if (stream.ended) {
                                releaseCall();
                                return { value: undefined as any, done: true };
                            }
                            // Park on the next chunk arrival. The deadline is
                            // the call's own, already running.
                            await new Promise<void>((resolve, reject) => {
                                stream.resolveNext = () => resolve();
                                stream.rejectNext = (err: Error) => reject(err);
                            });
                        }
                    },

                    async return(): Promise<IteratorResult<Buffer>> {
                        // Caller broke out of the for-await: stop the producer,
                        // not just our own buffering.
                        cancel();
                        return { value: undefined as any, done: true };
                    },

                    async throw(err): Promise<IteratorResult<Buffer>> {
                        cancel();
                        throw err;
                    },
                };
            },
        };
    }

    async close(): Promise<void> {
        this.connection.removeListener('disconnected', this._boundOnDisconnected);
        this._detachRestorer();
        delete (this as any)._boundOnDisconnected;
        await this.callbackListener.close();
    }
}
