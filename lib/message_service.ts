import { Logger } from './logger';
import { IContext } from './context';
import MessageFactory from './message_factory';
import MessageListener from './message_listener';
import EventListener, { EventHandler } from './event_listener';
import CancelListener from './cancel_listener';
import { isHandledError, sanitizeErrorForClient, ProtocolError } from './errors';
// HandledError is re-exported for users, isHandledError is used by MessageListener
export { HandledError, isHandledError } from './errors';
import * as fs from 'fs';

/**
 * The final dot-separated segment — the bare method name in both
 * `Combat.Player.shoot` and `REQUEST.Combat.Player.player6.shoot`.
 */
function lastSegment(value: string): string {
    const i = value.lastIndexOf('.');
    return i === -1 ? value : value.slice(i + 1);
}

/** The routing key the broker delivered on, when the caller passed one. */
function routingKeyOf(context?: { routingKey?: string } | string): string | undefined {
    return typeof context === 'string' ? context : context?.routingKey;
}

export class InvalidResultError extends Error {}
/**
 * The request named a method this service does not serve. A ProtocolError so
 * the connection layer answers the caller instead of retrying: the same body
 * names the same absent method on every redelivery.
 */
export class InvalidMethodError extends ProtocolError {}
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
     * Defaults to true. Acking on delivery disables the retry / DLQ /
     * error-reply path in the connection layer entirely: the message is
     * dropped and the caller waits for a reply that never comes. Set this to
     * false only for genuine at-most-once delivery with no error reporting.
     */
    lateAck?: boolean;
    /** Per-message processing timeout. Defaults to Config.messageProcessingTimeout. */
    processingTimeoutMs?: number;
}

export default abstract class MessageService implements IMessageService {
    protected context: IContext;

    private listener: MessageListener;
    private eventListener: EventListener;
    private cancelListener: CancelListener;
    /**
     * The service as its .proto declares it, which is not always ServiceName:
     * instances sharing one schema are addressed under distinct runtime names
     * (`Combat.Player.player6` all serving the contract `Combat.Player`).
     * Resolved from the factory rather than configured, so nothing has to be
     * declared twice.
     */
    private contractServiceName: string | undefined;
    /** Method names the contract declares. Nothing else is dispatchable. */
    private declaredMethods: Set<string> | undefined;
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
        this.cancelListener = new CancelListener(context.connection);
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
     * Registering here makes a service self-sufficient rather than relying on
     * the schema arriving via Context.init(protoLocations). Skipped when the
     * schema is already present, so passing a proto directory as well still
     * works.
     */
    private registerSchema(): void {
        if (this.context.factory.hasService(this.ServiceName)) {
            return;
        }
        this.context.factory.parse(this.Proto, this.ServiceName);
    }

    /**
     * Find the contract this service serves, by trimming runtime segments off
     * ServiceName until one names a service in the root.
     *
     * `Combat.Player.player6` is not in any schema; `Combat.Player` is. Doing
     * this by search rather than by asking the subclass keeps existing services
     * working without declaring the contract name a second time.
     */
    private resolveContract(): void {
        if (this.contractServiceName !== undefined) return;

        const factory = this.context.factory;
        let candidate = this.ServiceName;
        for (;;) {
            if (factory.hasService(candidate)) {
                this.contractServiceName = candidate;
                this.declaredMethods = new Set(factory.getServiceMethodNames(candidate));
                return;
            }
            const cut = candidate.lastIndexOf('.');
            if (cut <= 0) {
                throw new MissingProto(
                    `no service in the schema matches '${this.ServiceName}' or any prefix of it; ` +
                    'the .proto must declare the service this class serves',
                );
            }
            candidate = candidate.slice(0, cut);
        }
    }

    /**
     * The implementation of `name` defined by THIS service, or undefined.
     *
     * The walk stops at MessageService's own prototype, so a declared rpc can
     * only ever reach something the subclass wrote. A plain `this[name]` lookup
     * resolves an rpc named `init` or `publishEvent` to the framework's member
     * and calls it with the caller's arguments. ServiceProxy guards the same
     * collision by refusing to install such a name at all.
     */
    private resolveOwnHandler(name: string): ((...args: any[]) => any) | undefined {
        const asFunction = (value: unknown) =>
            (typeof value === 'function' ? value as (...args: any[]) => any : undefined);

        if (Object.prototype.hasOwnProperty.call(this, name)) {
            return asFunction((<any>this)[name]);
        }
        let proto = Object.getPrototypeOf(this);
        while (proto && proto !== MessageService.prototype) {
            if (Object.prototype.hasOwnProperty.call(proto, name)) {
                return asFunction(proto[name]);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return undefined;
    }

    public async init(): Promise<void> {
        try {
            this.registerSchema();
            this.resolveContract();
            await this.listener.init(this._onMessage.bind(this), this.ServiceName);
            await this.eventListener.init(undefined, `${this.ServiceName}.Events`);
            await this.listener.subscribe(`REQUEST.${this.ServiceName}.*`);
            await this.listener.start();
            await this.eventListener.start();
            // Started last: it only matters once requests can arrive.
            await this.cancelListener.start();
        } catch (err) {
            Logger.error(`error initializing service ${this.ServiceName} - ${err}\n${err.stack}`);
            throw err;
        }
    }

    /**
     * Stop accepting new requests and events, leaving channels open so work
     * already in hand can finish. The first step of a graceful shutdown; pair
     * it with `connection.drainInFlight()` before closing anything.
     */
    public async stopConsuming(): Promise<void> {
        await Promise.all([
            this.listener.stopConsuming(),
            this.eventListener.stopConsuming(),
            // Closed with the rest: a drained service has no stream left to cancel.
            this.cancelListener.close(),
        ]);
    }

    // core handler for incoming RPC requests made to REQUEST.<service name>.*
    private async _onMessage(
        data: any,
        id: string,
        _headers?: Record<string, any>,
        context?: { routingKey?: string } | string,
    ) {
        this.resolveContract();
        const factory = this.context.factory;

        // Envelope first, payload later. The envelope names the method, and
        // that name selects the schema the payload is read with — so it has to
        // be checked against this service's contract before the bytes are
        // interpreted, or a publisher picks which schema its payload is parsed
        // as and hands one service's request to another service's handler.
        let envelope: { method: string; actor: string; data: any };
        try {
            envelope = factory.decodeRequestEnvelope(data);
        } catch {
            // Undecodable bytes are not an infrastructure failure and must not
            // reach the retry ladder. Nothing here is publisher-supplied text:
            // the reply says only that the envelope did not parse.
            Logger.error(
                `unparseable request envelope on ${this.ServiceName} (${data?.length ?? 0} bytes, ${id})`,
            );
            return this._protocolError(routingKeyOf(context), 'request envelope did not decode');
        }
        Logger.debug(`received request ${envelope.method} (${id})`);

        // The method to run comes from the message body, so it must be checked
        // against what the broker actually routed and against this service's
        // own name. Without this, a client that can publish to the bus picks the
        // method regardless of the routing key — which makes RabbitMQ topic
        // permissions unenforceable and lets one service's request schema be
        // paired with another service's handler.
        const routingKey = routingKeyOf(context);
        // Passed on to the service method as a 4th argument. A streaming
        // handler watches `signal` to stop producing when the caller cancels;
        // it also fires on the processing timeout.
        const handlerContext = typeof context === 'string' ? undefined : context;
        // A rejection is reported against the method the ROUTING KEY names, not
        // the one the body asked for: the body's name is exactly what is in
        // dispute, and encoding a response for it means looking it up.
        const contractMethod = `${this.contractServiceName}.${
            routingKey !== undefined ? lastSegment(routingKey) : lastSegment(envelope.method)}`;
        const rejectDispatch = (reason: string) => {
            const error = new InvalidMethodError(reason);
            Logger.error(reason);
            return factory.buildResponse(contractMethod, error);
        };

        // Both checks are expressed against the routing key rather than the
        // service name, so they hold when a service's runtime name differs
        // from the name declared in its .proto — several instances may share
        // one schema, with the proto method `Combat.Player.shoot` addressed by
        // routing key `REQUEST.Combat.Player.player6.shoot`.
        //
        //   1. The delivery belongs to THIS service — checked against the
        //      routing key the broker used, not against the body, since the
        //      body is publisher-controlled.
        //   2. The method the body asks for is the method the routing key
        //      names, so a client that can publish cannot route to one method
        //      and have another executed. This is what keeps RabbitMQ topic
        //      permissions meaningful.
        if (routingKey !== undefined) {
            if (!routingKey.startsWith(`REQUEST.${this.ServiceName}.`)) {
                return rejectDispatch(
                    `routing key ${routingKey} does not belong to service ${this.ServiceName}`,
                );
            }
            if (lastSegment(routingKey) !== lastSegment(envelope.method)) {
                return rejectDispatch(
                    `request method ${envelope.method} contradicts routing key ${routingKey}`,
                );
            }
        }

        //   3. The body names a method of THIS contract, spelled in full. The
        //      whole name is compared, not its last segment, so a name cannot
        //      carry extra segments that change which handler is chosen while
        //      the schema is taken from an earlier one — nor name a method that
        //      belongs to some other service whose schema happens to be loaded.
        let method: string;
        try {
            const parsed = MessageFactory.splitMethodName(envelope.method);
            if (parsed.serviceName !== this.contractServiceName) {
                return rejectDispatch(
                    `request method ${envelope.method} is not a method of ${this.contractServiceName}`,
                );
            }
            method = parsed.methodName;
        } catch {
            return rejectDispatch(`request method ${envelope.method} is not a qualified method name`);
        }

        if (!this.declaredMethods.has(method)) {
            return rejectDispatch(
                `${this.contractServiceName} declares no method ${method}`,
            );
        }

        // Only what this service itself implements. A declared rpc whose name
        // matches a framework member resolves to nothing here rather than to
        // the framework's method.
        const handler = this.resolveOwnHandler(method);
        if (!handler) {
            const error = new InvalidMethodError(`invalid service method ${method}`);
            Logger.error(error.message);
            return factory.buildResponse(envelope.method, error);
        }

        // Validated: the payload can now be read against the contract's schema.
        let request: { method: string; actor: string; data: any };
        try {
            request = {
                method: envelope.method,
                actor: envelope.actor,
                data: factory.decodeRequestPayload(envelope.method, envelope.data),
            };
        } catch {
            // Type name and size only — a payload that failed to decode is
            // still a payload, and may be one byte away from readable.
            Logger.error(
                `unparseable request payload for ${envelope.method} ` +
                `(${envelope.data?.length ?? 0} bytes, ${id})`,
            );
            return this._protocolError(
                envelope.method, `payload did not decode as the request type of ${envelope.method}`,
            );
        }

        // Streaming path: if the .proto declares this method as
        // server-streaming, the handler is expected to return an
        // AsyncIterable<chunkData>. The framework wraps each yielded chunk
        // in a ResponseContainer; the connection layer publishes them with
        // x-protobus-final headers. See docs/advanced/streaming.md.
        if (this.context.factory.isStreamingMethod(request.method)) {
            const iter = handler.call(this, request.data, request.actor, id, handlerContext);
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
            p = handler.call(this, request.data, request.actor, id, handlerContext);
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
     * Answer a message this service could not understand.
     *
     * A ProtocolError, so the connection layer replies to the caller and
     * rejects the delivery instead of running the retry ladder over bytes that
     * will fail to decode identically every time.
     */
    private _protocolError(label: string | undefined, reason: string): Buffer {
        return this.context.factory.buildResponse(label || 'unknown', new ProtocolError(reason));
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
                // What the CALLER sees is sanitized; what we log below is the
                // real error. An unhandled exception's message is written for
                // this service's operators, not for another service.
                (error as any).__PROTOBUS_RESPONSE_BUFFER = this.context.factory.buildResponse(
                    method, sanitizeErrorForClient(error),
                );
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
            // Same boundary as the unary path: the stream's terminal error is
            // published to the caller, so it gets the sanitized form.
            yield this.context.factory.buildResponse(method, sanitizeErrorForClient(error));
        }
    }
}
