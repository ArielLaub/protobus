import { Logger } from './logger';
import { IContext } from './context';
import MessageListener from './message_listener';
import EventListener, { EventHandler } from './event_listener';
import { isHandledError } from './errors';
// HandledError is re-exported for users, isHandledError is used by MessageListener
export { HandledError, isHandledError } from './errors';
import * as fs from 'fs';

export class InvalidResultError extends Error {}
export class InvalidMethodError extends Error {}
export class MissingProto extends Error {}

export interface IContextConstructable {
    new (context: IContext): IMessageService;
}

export interface IMessageService {
    ServiceName: string;
    ProtoFileName: string;
    Proto: string;

    init(): Promise<void>;
    publishEvent(type: string, content: any, topic?: any): Promise<any>;
    subscribeEvent(type: string, handler: EventHandler, topic?: string): Promise<any>;
}

export interface RetryOptions {
    maxRetries?: number;       // Max retry attempts (default: 3, 0 = no retries)
    retryDelayMs?: number;     // Delay between retries in ms (default: 5000)
    messageTtlMs?: number;     // Message TTL in ms (default: undefined = no TTL)
}

export const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'messageTtlMs'>> & Pick<RetryOptions, 'messageTtlMs'> = {
    maxRetries: 3,
    retryDelayMs: 5000,
    messageTtlMs: undefined,
};

export interface IMessageServiceOptions {
    maxConcurrent?: number;
    retry?: RetryOptions;
    /**
     * Ack after the handler completes (default) rather than on delivery.
     *
     * This used to be derived from `maxConcurrent`, so a service constructed
     * without options acked on delivery — which silently disabled the entire
     * retry / DLQ / error-reply path in the connection layer, dropped the
     * message, and left the caller waiting for a reply that never came. It is
     * now an explicit option defaulting to true. Set it to false only if you
     * genuinely want at-most-once delivery with no error reporting.
     */
    lateAck?: boolean;
    /** Per-message processing timeout. Defaults to Config.messageProcessingTimeout. */
    processingTimeoutMs?: number;
}

export default abstract class MessageService implements IMessageService {
    protected context: IContext;

    private listener: MessageListener;
    private eventListener: EventListener;
    private retryOptions: Required<Omit<RetryOptions, 'messageTtlMs'>> & Pick<RetryOptions, 'messageTtlMs'>;

    constructor (context: IContext, options: IMessageServiceOptions = {}) {
        this.context = context;
        this.retryOptions = {
            ...DEFAULT_RETRY_OPTIONS,
            ...options.retry,
        };
        this.listener = new MessageListener(
            context.connection,
            options.lateAck ?? true,
            options.maxConcurrent,
            this.retryOptions,
            options.processingTimeoutMs,
        );
        this.eventListener = new EventListener(context.connection, context.factory);
    }

    public abstract get ServiceName(): string;
    public abstract get ProtoFileName(): string;

    public get Proto(): string {
        const defaultProtoFile = this.ProtoFileName;
        if (fs.existsSync(defaultProtoFile)) {
            return fs.readFileSync(defaultProtoFile).toString();
        } else {
            throw new MissingProto('missing_proto_source');
        }
    }

    public async publishEvent(type: string, content: any, topic?: any) {
        return this.context.publishEvent(type, content, topic);
    }

    public async subscribeEvent(type: string, handler: EventHandler, topic?: string) {
        return this.eventListener.subscribe(type, handler, topic);
    }

    /**
     * Make sure this service's schema is in the factory's root.
     *
     * ServiceCluster used to be the only caller of factory.parse(), so a
     * service started on its own relied on the schema arriving via
     * Context.init(protoLocations). Registering here makes a standalone service
     * self-sufficient; it is skipped when the schema is already present, so
     * passing a proto directory as well still works.
     */
    private registerSchema(): void {
        if (this.context.factory.hasService(this.ServiceName)) {
            return;
        }
        this.context.factory.parse(this.Proto, this.ServiceName);
    }

    public async init(): Promise<void> {
        try {
            this.registerSchema();
            await this.listener.init(this._onMessage.bind(this), this.ServiceName);
            await this.eventListener.init(undefined, `${this.ServiceName}.Events`);
            await this.listener.subscribe(`REQUEST.${this.ServiceName}.*`);
            await this.listener.start();
            await this.eventListener.start();
        } catch (err) {
            Logger.error(`error initializing service ${this.ServiceName} - ${err}\n${err.stack}`);
            throw err;
        }
    }

    // core handler for incoming RPC requests made to REQUEST.<service name>.*
    private async _onMessage(
        data: any,
        id: string,
        _headers?: Record<string, any>,
        context?: { routingKey?: string } | string,
    ) {
        const request = this.context.factory.decodeRequest(data);
        const method = request.method.split('.')[2]; // <package>.<service>.<method>
        Logger.debug(`received request ${request.method} (${id})`);

        // The method to run comes from the message body, so it must be checked
        // against what the broker actually routed and against this service's
        // own name. Without this, a client that can publish to the bus picks the
        // method regardless of the routing key — which makes RabbitMQ topic
        // permissions unenforceable and lets one service's request schema be
        // paired with another service's handler.
        const routingKey = typeof context === 'string' ? context : context?.routingKey;
        const rejectDispatch = (reason: string) => {
            const error = new InvalidMethodError(reason);
            Logger.error(reason);
            return this.context.factory.buildResponse(request.method, error);
        };

        if (!request.method.startsWith(`${this.ServiceName}.`)) {
            return rejectDispatch(
                `request method ${request.method} does not belong to service ${this.ServiceName}`,
            );
        }
        if (routingKey !== undefined && routingKey !== `REQUEST.${request.method}`) {
            return rejectDispatch(
                `request method ${request.method} contradicts routing key ${routingKey}`,
            );
        }

        const handler = (<any>this)[method];
        if (!handler || typeof handler !== 'function') {
            const error = new InvalidMethodError(`invalid service method ${method}`);
            Logger.error(error.message);
            return this.context.factory.buildResponse(request.method, error);
        }

        // Streaming path: if the .proto declares this method as
        // server-streaming, the handler is expected to return an
        // AsyncIterable<chunkData>. The framework wraps each yielded chunk
        // in a ResponseContainer; the connection layer publishes them with
        // x-protobus-final headers. See docs/advanced/streaming.md.
        if (this.context.factory.isStreamingMethod(request.method)) {
            const iter = handler.call(this, request.data, request.actor, id);
            if (!iter || typeof iter[Symbol.asyncIterator] !== 'function') {
                const error = new InvalidResultError(
                    `streaming method ${method} must return an AsyncIterable`,
                );
                return this.context.factory.buildResponse(request.method, error);
            }
            return this._streamResponses(request.method, iter);
        }

        // Unary path
        let p: any;
        try {
            p = handler.call(this, request.data, request.actor, id);
        } catch (error) {
            // Synchronous throw from the handler — handled-vs-unhandled split below.
            return this.handleUnaryError(request.method, error);
        }
        if (!p || !p.then) {
            return this.handleUnaryError(request.method, new InvalidResultError(p));
        }
        try {
            const result = await p;
            // No payload in the log line — responses carry secrets and PII.
            Logger.debug(`sending result ${request.method} (${id})`);
            return this.context.factory.buildResponse(request.method, result);
        } catch (error) {
            return this.handleUnaryError(request.method, error);
        }
    }

    /**
     * Decide what to do with an error from a unary handler.
     *
     * `HandledError` (and anything `isHandledError`-shaped) is *expected* —
     * validation failures, business-logic rejections. We return it as a
     * normal error response so the client sees it immediately. No retry.
     *
     * Anything else is treated as an *infrastructure* failure (timeout,
     * connection issue, unexpected bug) and is re-thrown so the connection
     * layer's retry/DLQ machinery takes over. The client receives a response
     * only after the retries succeed OR are exhausted (DLQ path publishes
     * the final error back to the caller — see connection.ts).
     */
    private handleUnaryError(method: string, error: unknown): Buffer {
        if (isHandledError(error)) {
            Logger.warn(`handled error in ${method}: ${(error as any).message || error}`);
            return this.context.factory.buildResponse(method, error);
        }
        // Pre-encode the error as a ResponseContainer so the connection
        // layer can publish it back to the caller on the DLQ / reject paths
        // (after retries are exhausted) without needing access to the
        // MessageFactory. The connection layer reads this off the thrown
        // error via a well-known symbol — see __PROTOBUS_RESPONSE_BUFFER below.
        if (error && typeof error === 'object') {
            try {
                (error as any).__PROTOBUS_RESPONSE_BUFFER = this.context.factory.buildResponse(method, error);
            } catch (encodeErr) {
                // If we can't encode the error, fall back to throwing without
                // a buffer. The client will time out — better than crashing here.
                Logger.warn(`failed to pre-encode error response: ${(encodeErr as any)?.message}`);
            }
        }
        if (error) {
            Logger.error((error as any).stack || (error as any).message || String(error));
        } else {
            Logger.error('null error received');
        }
        throw error;
    }

    /**
     * Wrap a user async-iterable so each chunk is encoded as a
     * ResponseContainer Buffer before being handed to the connection layer.
     * An exception during iteration becomes a terminal error response — the
     * connection layer publishes it with x-protobus-final=true so the
     * client's iterator raises.
     */
    private async *_streamResponses(method: string, iter: AsyncIterable<any>): AsyncIterable<Buffer> {
        try {
            for await (const chunk of iter) {
                yield this.context.factory.buildResponse(method, chunk);
            }
        } catch (error) {
            if (error) {
                Logger.error((error as any).stack || (error as any).message || String(error));
            }
            yield this.context.factory.buildResponse(method, error);
        }
    }
}
