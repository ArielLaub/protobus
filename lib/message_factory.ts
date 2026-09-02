import * as fs from 'fs';
import * as path from 'path';
import * as protoBuf from 'protobufjs';
import { Type, Field, OneOf, Message } from 'protobufjs/light';
import { Logger } from './logger';
import {
    ICustomType,
    registerCustomType,
    refreshCustomTypeCodec,
    CustomTypeConflictError,
    getCustomType,
    isCustomType,
    getCustomTypeNames,
    BigIntMessage,
    TimestampMessage
} from './custom_types';

export class MessageTypeRequiredError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'MessageTypeRequiredError';
    }
}
export class NotInitializedError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'NotInitializedError';
    }
}
/** A name that is not of the form `<package>.<Service>.<method>`. */
export class InvalidMethodNameError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'InvalidMethodNameError';
    }
}
/** A well-formed name whose method is not declared by the named service. */
export class UnknownMethodError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'UnknownMethodError';
    }
}

/**
 * Every parse this module performs passes `keepCase: true` explicitly — the
 * Root constructor, `loadSync()` and `parse()` alike — so field names reach the
 * wire exactly as the .proto declares them.
 *
 * It is passed per call rather than by assigning `protoBuf.parse.defaults`,
 * because that object is protobufjs's module-level state: writing to it changes
 * how every *other* consumer of protobufjs in the same process parses, which is
 * not ours to decide.
 */

/**
 * Resolve a field if protobufjs hasn't done it yet.
 *
 * protobufjs resolves lazily, so `field.resolvedType` is null until something
 * forces resolution. Anything that inspects the type tree *before* the first
 * encode must resolve explicitly — otherwise nested message fields look like
 * scalars and get skipped, encoding nested bigint/timestamp fields as zero.
 */
function ensureResolved(field: protoBuf.Field): void {
    if (!field.resolved) {
        try {
            field.resolve();
        } catch {
            // A field referencing a type that isn't in the root yet. Leaving it
            // unresolved is fine here: callers treat "unknown" conservatively.
        }
    }
}

/**
 * Check if a message type or any of its nested types contain custom types.
 *
 * Cycles (`message Tree { Tree child = 1; }`) are resolved *conservatively*:
 * re-entering a type that is already on the stack returns true, so recursive
 * schemas always take the preprocessing path. Returning false there would be
 * wrong — a cycle can reach a custom type through its back edge — and
 * recursing again would overflow the stack. Preprocessing a message that
 * turns out to have no custom types is merely slower, never incorrect.
 */
function messageNeedsPreprocess(
    messageType: protoBuf.Type,
    cache: Map<string, boolean>,
    visiting: Set<string> = new Set(),
): boolean {
    const fullName = messageType.fullName;

    if (cache.has(fullName)) {
        return cache.get(fullName)!;
    }
    if (visiting.has(fullName)) {
        return true; // cycle — assume it needs preprocessing
    }
    visiting.add(fullName);

    let needsIt = false;

    for (const fieldName of Object.keys(messageType.fields)) {
        const field = messageType.fields[fieldName];

        // Check if field is a custom type
        if (isCustomType(field.type)) {
            needsIt = true;
            break;
        }

        // Check nested message types recursively
        ensureResolved(field);
        if (field.resolvedType instanceof protoBuf.Type) {
            if (messageNeedsPreprocess(field.resolvedType, cache, visiting)) {
                needsIt = true;
                break;
            }
        }
    }

    visiting.delete(fullName);
    cache.set(fullName, needsIt);
    return needsIt;
}

// Re-export custom types functionality
export {
    ICustomType, registerCustomType, refreshCustomTypeCodec, CustomTypeConflictError,
    getCustomType, isCustomType, getCustomTypeNames,
};
export { BigIntMessage, TimestampMessage };
export { bigintToBytes, bytesToBigint, BigIntType, TimestampType } from './custom_types';

// Helper to preprocess objects before encoding - converts custom type values
function preprocessForEncode(obj: any, messageType: protoBuf.Type, registeredTypes: Map<string, typeof Message>): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map((item) => preprocessForEncode(item, messageType, registeredTypes));
    }

    const result: any = {};
    for (const key of Object.keys(obj)) {
        const field = messageType.fields[key];
        if (field) { ensureResolved(field); }
        if (field && isCustomType(field.type)) {
            // Convert using custom type's encode function
            const customType = getCustomType(field.type);
            const MessageClass = registeredTypes.get(field.type);
            const val = obj[key];
            if (val !== null && val !== undefined && customType && MessageClass) {
                if (Array.isArray(val)) {
                    result[key] = val.map(v => (MessageClass as any).create({ value: customType.encode(v) }));
                } else {
                    result[key] = (MessageClass as any).create({ value: customType.encode(val) });
                }
            } else {
                result[key] = val;
            }
        } else if (field && field.resolvedType instanceof protoBuf.Type) {
            // Nested message type - recurse
            if (Array.isArray(obj[key])) {
                result[key] = obj[key].map((item: any) => preprocessForEncode(item, field.resolvedType as protoBuf.Type, registeredTypes));
            } else {
                result[key] = preprocessForEncode(obj[key], field.resolvedType as protoBuf.Type, registeredTypes);
            }
        } else {
            result[key] = obj[key];
        }
    }
    return result;
}

export interface IEventContainer {
    type: string;
    topic: string;
    data: Buffer;
}
@Type.d('EventContainer')
class EventContainer extends Message<EventContainer> implements IEventContainer {
    @Field.d(1, 'string')
    public type: string;

    @Field.d(2, 'string')
    public topic: string;

    @Field.d(3, 'bytes')
    public data: Buffer;
}

export interface IRequestContainer {
    method: string;
    actor: string;
    data: any;
}
@Type.d('RequestContainer')
class RequestContainer extends Message<RequestContainer> implements IRequestContainer {
    @Field.d(1, 'string')
    public method: string;

    @Field.d(2, 'string')
    public actor: string;

    @Field.d(3, 'bytes')
    public data: Buffer;
}

export interface IResponseResult {
    method: string;
    data: any;
}
@Type.d('ResponseResult')
class ResponseResult extends Message<ResponseResult> implements IResponseResult {
    @Field.d(1, 'string')
    public method: string;

    @Field.d(2, 'bytes')
    public data: Buffer;
}

export interface IResponseError {
    method: string;
    message: string;
    code: string;
}

@Type.d('ResponseError')
class ResponseError extends Message<ResponseError> implements IResponseError {
    @Field.d(1, 'string')
    public method: string;

    @Field.d(2, 'string')
    public message: string;

    @Field.d(3, 'string')
    public code: string;
}

export interface IResponseContainer {
    result?: IResponseResult;
    error?: IResponseError;
    value: string;
}

@Type.d('ResponseContainer')
class ResponseContainer extends Message<ResponseContainer> implements IResponseContainer {
    @Field.d(1, ResponseResult)
    public result: ResponseResult;

    @Field.d(2, ResponseError)
    public error: ResponseError;

    @OneOf.d('ResponseResult', 'ResponseError')
    public value: string;
}

function findFiles(startPath: string, filter: string, parentFiltered?: any[]): string[] {
    const files = fs.readdirSync(startPath);
    const filtered = parentFiltered || [];
    const childDirs: string[] = [];
    files.forEach((filename: string) => {
        const fullName = path.join(startPath, filename);
        const stat = fs.lstatSync(fullName);

        // endsWith, not indexOf: indexOf('.proto') also matched files like
        // notes.protocol.txt and schema.proto.bak, feeding them to the parser.
        if (stat.isDirectory()) { childDirs.push(fullName); } else if (filename.endsWith(filter)) { filtered.push(fullName); }
    });

    childDirs.forEach((fullName) => {
        Logger.debug(`scanning ${fullName} for ${filter} files`);
        findFiles(fullName, filter, filtered);
    });

    return filtered;
}

/**
 * Copy protobufjs's writer output into a Buffer of its own.
 *
 * `finish()` hands back a view into protobufjs's shared allocation pool. The
 * previous implementation returned another view over that same pool, so every
 * message in flight pinned the whole pooled ArrayBuffer (8 KB by default) for
 * as long as it was referenced. Copying costs one small memcpy and lets the
 * pool be reclaimed.
 */
function uintArrayToBuffer(arr: Uint8Array): Buffer {
    return Buffer.from(arr.subarray(0, arr.byteLength));
}

export default class MessageFactory {
    public root: protoBuf.Root;
    private isInitialized: boolean = false;
    private registeredTypes: Map<string, typeof Message> = new Map();
    /**
     * Schema texts already added to the current root, so re-registering the
     * same .proto is a no-op regardless of the service name it arrives under.
     */
    private parsedSchemas: Set<string> = new Set();
    /**
     * Per-instance, not module-global: two factories holding different roots
     * with same-named types must not share preprocessing decisions.
     */
    private needsPreprocessCache: Map<string, boolean> = new Map();

    constructor() {
    }

    /**
     * Split a fully-qualified method name into its service and method halves.
     *
     * Parsed from the RIGHT: the method is the final segment and the service is
     * everything before it. Counting segments from the left instead assumes a
     * single-segment package, so `com.example.Calc.add` looked for a service
     * named `com.example`. It also left the trailing segments unexamined, which
     * is what let a name carry a fourth segment past the method.
     */
    public static splitMethodName(fullName: string): { serviceName: string; methodName: string } {
        const i = typeof fullName === 'string' ? fullName.lastIndexOf('.') : -1;
        if (i <= 0 || i === fullName.length - 1) {
            throw new InvalidMethodNameError(
                `'${fullName}' is not a fully-qualified method name (<package>.<Service>.<method>)`,
            );
        }
        return { serviceName: fullName.slice(0, i), methodName: fullName.slice(i + 1) };
    }

    private getMethodType(fullName: string): protoBuf.Method  {
        const { serviceName, methodName } = MessageFactory.splitMethodName(fullName);
        const TService = this.root.lookupService(serviceName);
        const method = TService.methods[methodName];
        if (!method) {
            // Returning undefined made the caller fail on a property access
            // several frames away, naming neither the method nor the service.
            throw new UnknownMethodError(
                `service '${serviceName}' declares no method '${methodName}'`,
            );
        }
        return method;
    }

    /**
     * Return true if the given fully-qualified method is declared as
     * server-streaming in its .proto file.
     *
     * Uses the standard gRPC `stream` keyword on the response type, which
     * protobufjs surfaces as `Method.responseStream = true`. Methods missing
     * from the schema return false (treated as unary).
     *
     * @param fullName - Fully-qualified method name (e.g. "Llm.Service.completeStream")
     */
    public isStreamingMethod(fullName: string): boolean {
        try {
            const method = this.getMethodType(fullName);
            // protobufjs uses .resolve() lazily; call it to ensure responseStream is populated
            method.resolve();
            return method.responseStream === true;
        } catch (error) {
            // Treated as unary, but say so — a typo'd or unregistered method
            // silently degrading to unary is very hard to diagnose otherwise.
            Logger.debug(`isStreamingMethod(${fullName}): treating as unary (${(error as any)?.message ?? error})`);
            return false;
        }
    }

    /**
     * Register a custom type and add it to this factory's root.
     *
     * **The registration is process-wide, not per instance.** The type's
     * codec goes into protobufjs's module-level `wrappers` table and into a
     * module-level registry, both shared by everything in the process — so a
     * type registered through one factory is visible to
     * `isCustomType`/`getCustomType` everywhere, and two factories cannot hold
     * different definitions of the same name. Only the addition to `root` is
     * per instance.
     *
     * The built-in `bigint` and `timestamp` are registered the same way, at
     * import time, before any factory exists.
     *
     * @param customType - The custom type definition
     * @returns The generated Message class for the type
     *
     * @example
     * ```typescript
     * const uuidType: ICustomType<string> = {
     *     name: 'uuid',
     *     wireType: 'bytes',
     *     tsType: 'string',
     *     encode: (value: string) => Buffer.from(value.replace(/-/g, ''), 'hex'),
     *     decode: (data: Buffer) => {
     *         const hex = data.toString('hex');
     *         return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
     *     }
     * };
     *
     * messageFactory.registerType(uuidType);
     * ```
     */
    public registerType<T>(customType: ICustomType<T>): typeof Message {
        // Idempotent. Registering a name this factory already holds — the
        // built-in `bigint`/`timestamp`, or a type re-registered on a reload —
        // used to fail with protobufjs's "duplicate name '<name>' in Root",
        // because a second message class was generated and added to a root
        // that already had one under that name. There was no way to ask
        // whether a name was taken, so the throw was unavoidable rather than
        // merely inconvenient.
        //
        // The codec is still refreshed, so the last definition of a name wins
        // exactly as it did before; only the redundant type generation is
        // skipped. A definition that disagrees about `wireType` is refused
        // instead — see CustomTypeConflictError.
        const known = this.registeredTypes.get(customType.name);
        if (known) {
            refreshCustomTypeCodec(customType);
            return known;
        }

        const MessageClass = registerCustomType(customType);
        this.registeredTypes.set(customType.name, MessageClass);

        // Add to root if already initialized
        if (this.isInitialized && this.root) {
            this.root.add((MessageClass as any).$type);
        }

        return MessageClass;
    }

    public init(rootPaths: string[]) {

        const fileNames: string[] = [];
        rootPaths.forEach(rootPath => {
            const newFiles = findFiles(rootPath, '.proto');
            newFiles.forEach(newFile => fileNames.push(newFile));
        });

        // The root and its custom types must exist BEFORE any .proto is loaded.
        // loadSync() resolves eagerly, so loading first meant a schema using
        // `bigint` failed with "no such type: 'bigint'" — the custom types were
        // added a few lines too late.
        this.root = new protoBuf.Root({ keepCase: true });
        // Tied to the root's lifetime: a fresh root has nothing registered, so
        // the "already parsed" memo must start empty alongside it.
        this.parsedSchemas.clear();

        this.root.add((BigIntMessage as any).$type);
        this.registeredTypes.set('bigint', BigIntMessage);

        this.root.add((TimestampMessage as any).$type);
        this.registeredTypes.set('timestamp', TimestampMessage);

        // Register any types that were added before init
        for (const [name, MessageClass] of this.registeredTypes) {
            if (name !== 'bigint' && name !== 'timestamp') {
                this.root.add((MessageClass as any).$type);
            }
        }

        if (fileNames.length) {
            Logger.info(`loading ${fileNames.length} proto file(s)`);
            this.root.loadSync(fileNames, { keepCase: true });

            // loadSync bypasses parse(), so record what came off disk here.
            // A service whose Proto getter reads a file already loaded from a
            // proto directory must recognise it as present rather than
            // re-parsing it into a duplicate-name error.
            for (const fileName of fileNames) {
                try {
                    this.parsedSchemas.add(fs.readFileSync(fileName).toString());
                } catch (err: any) {
                    // Non-fatal: the schema is loaded either way, we just lose
                    // the ability to recognise a later re-registration of it.
                    Logger.debug(`could not memoise schema text for ${fileName}: ${err?.message || err}`);
                }
            }
        }

        this.isInitialized = true;
        Logger.debug('message factory initialized');
    }

    /** True if the given fully-qualified service is already in the root. */
    public hasService(fullName: string): boolean {
        if (!this.root) return false;
        try {
            return !!this.root.lookupService(fullName);
        } catch {
            return false;
        }
    }

    /**
     * Add a schema to the root.
     *
     * Idempotent: re-parsing a schema already present is a no-op rather than a
     * protobufjs duplicate-name error. A MessageService registers its own
     * schema during init(), and the same schema legitimately arrives twice when
     * a proto directory was also passed to Context.init().
     *
     * Two guards, because the service name alone is not enough: a service's
     * runtime name need not be the name declared in its .proto, and several
     * instances can share one schema under distinct names. Keying on the
     * schema text as well makes the check independent of naming.
     *
     * Conflicting definitions are still an error: identical TEXT is a no-op,
     * a different definition of the same type is not.
     */
    public parse(proto: string, moduleName?: string): void {
        // init() is what creates the root. Without it, protobufjs is handed an
        // undefined root, quietly makes one of its own, parses into that and
        // drops it on return — so the call succeeds and the schema is simply
        // not there. The failure then surfaces somewhere else entirely, as a
        // `no such Service` or a MissingProto in code that plainly registered
        // it. Refuse the call instead, at the point the mistake was made.
        if (!this.isInitialized || !this.root) {
            throw new NotInitializedError(
                `cannot parse schema${moduleName ? ` for ${moduleName}` : ''} before `
                + 'MessageFactory.init() has run: there is no root to parse into, and the '
                + 'schema would be silently discarded. Call Context.init() (or '
                + 'MessageFactory.init()) first.',
            );
        }
        if (moduleName && this.hasService(moduleName)) {
            Logger.debug(`schema for ${moduleName} already registered, skipping`);
            return;
        }
        if (this.parsedSchemas.has(proto)) {
            Logger.debug(
                `schema text already registered${moduleName ? ` (as ${moduleName})` : ''}, skipping`,
            );
            return;
        }
        // protobufjs reports the source of a syntax error as "(<filename>, line
        // n)", and takes that filename from a property on the parse function
        // itself — there is no per-call option for it. Naming the module is
        // worth a lot when a schema fails to parse, so set it, and restore the
        // previous value in a finally so nothing is left behind: protobufjs
        // clears it on the way out of a *successful* parse but not when one
        // throws, which is exactly when a stale name would go on to mislabel
        // some unrelated caller's error. parse() is synchronous, so no other
        // code can observe the property while it is borrowed.
        const parser = <any>protoBuf.parse;
        const previousFilename = parser.filename;
        try {
            if (moduleName) {
                parser.filename = moduleName;
            }
            protoBuf.parse(proto, this.root, { keepCase: true });
        } finally {
            parser.filename = previousFilename;
        }
        this.parsedSchemas.add(proto);
    }

    public decodeMessage(messageType: string, data: Buffer) {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');
        if (!messageType) throw new MessageTypeRequiredError('message type required');
        const Message = this.root.lookupType(messageType);

        try {
            // `defaults: true` is required for proto3 correctness, not a
            // convenience. proto3 omits any scalar equal to its default from
            // the wire, so without this a legitimate 0, "" or false decodes as
            // undefined and is indistinguishable from a field nobody set —
            // a distinction proto3 does not have for scalars.
            return Message.toObject(Message.decode(data), {
                arrays: true,
                defaults: true,
                enums: String,
            });
        } catch (error) {
            // Deliberately no payload in the log line — message bodies routinely
            // carry credentials and personal data. Type name and byte length only.
            Logger.error(`error decoding message ${messageType} (${data?.length ?? 0} bytes)`);
            throw error;
        }
    }

    public buildRequest(methodFullName: string, obj: any, actor: string): Buffer {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');

        const TMethod = this.getMethodType(methodFullName);
        const messageType = TMethod.requestType;
        const Message = this.root.lookupType(messageType);
        try {
            // OPTIMIZATION: Skip preprocessing if message has no custom types
            const processed = messageNeedsPreprocess(Message, this.needsPreprocessCache)
                ? preprocessForEncode(obj, Message, this.registeredTypes)
                : obj;
            const request = RequestContainer.create({
                method: methodFullName,
                actor,
                data: Message.encode(Message.create(processed)).finish()
            });
            return uintArrayToBuffer(RequestContainer.encode(request).finish());
        } catch (error) {
            Logger.error(`error building request ${messageType}: ${(error as any)?.message ?? error}`);
            throw error;
        }
    }

    /** Method names declared by a service, in declaration order. */
    public getServiceMethodNames(serviceFullName: string): string[] {
        return Object.keys(this.root.lookupService(serviceFullName).methods);
    }

    /**
     * Decode the request envelope only, leaving `data` as the undecoded payload.
     *
     * Separate from the payload decode so a caller can check which method the
     * envelope names *before* interpreting the bytes. Decoding first means
     * choosing the schema from a publisher-controlled field, which is how one
     * service's payload ends up parsed as another's.
     */
    public decodeRequestEnvelope(data: Buffer): IRequestContainer {
        const request = RequestContainer.decode(data);
        const result = request.toJSON();
        return { method: result.method, actor: result.actor, data: request.data };
    }

    /** Decode a request payload against the declared request type of `methodFullName`. */
    public decodeRequestPayload(methodFullName: string, payload: Buffer): any {
        const TMethod = this.getMethodType(methodFullName);
        return this.decodeMessage(TMethod.requestType, payload);
    }

    public decodeRequest(data: Buffer): IRequestContainer {
        const envelope = this.decodeRequestEnvelope(data);
        return {
            method: envelope.method,
            data: this.decodeRequestPayload(envelope.method, envelope.data),
            actor: envelope.actor,
        };
    }

    public buildResponse(methodFullName: string, obj: any): Buffer {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');
        let response = undefined;

        if (obj instanceof Error) {
            // No method lookup on this path: an error response carries the
            // method only as a label, and resolving it would make a failure
            // that is *about* an unknown method impossible to report — leaving
            // the caller to wait out its whole RPC timeout instead.
            response = ResponseContainer.create({
                error: ResponseError.create({
                    method: methodFullName,
                    message: obj.message,
                    code: (obj as any).code || ''
                }),
            });
        } else {
            const messageType = this.getMethodType(methodFullName).responseType;
            const Message = this.root.lookupType(messageType);
            try {
                // OPTIMIZATION: Skip preprocessing if message has no custom types
                const processed = messageNeedsPreprocess(Message, this.needsPreprocessCache)
                    ? preprocessForEncode(obj, Message, this.registeredTypes)
                    : obj;
                response = ResponseContainer.create({
                    result: ResponseResult.create({
                        method: methodFullName,
                        data: Message.encode(Message.create(processed)).finish(),
                    }),
                });
            } catch (error) {
                Logger.error(`error building response ${messageType}: ${(error as any)?.message ?? error}`);
                throw error;
            }
        }
        return uintArrayToBuffer(ResponseContainer.encode(response).finish());
    }

    public decodeResponse(data: Buffer): IResponseContainer {
        const response = ResponseContainer.decode(data);
        if (!response.error) {
            const result = <IResponseResult>response.result;
            const TMethod = this.getMethodType(result.method);
            const messageType = TMethod.responseType;

            result.data = this.decodeMessage(messageType, result.data);
        }
        return response;
    }

    public buildEvent(type: string, obj: any, topic: string): Buffer {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');
        const Event = this.root.lookupType(type);

        try {
            // OPTIMIZATION: Skip preprocessing if message has no custom types
            const processed = messageNeedsPreprocess(Event, this.needsPreprocessCache)
                ? preprocessForEncode(obj, Event, this.registeredTypes)
                : obj;
            return uintArrayToBuffer(EventContainer.encode(EventContainer.create({
                type,
                topic,
                data: Event.encode(Event.create(processed)).finish(),
            })).finish());
        } catch (err) {
            Logger.error(`failed building event message ${type}: ${(err as any)?.message ?? err}`);
            throw err;
        }
    }

    public decodeEvent(data: Buffer): IEventContainer {
        const event = <any>EventContainer.decode(data);
        event.data = this.decodeMessage(event.type, event.data);
        return event;
    }

    public exportTS(serviceNames: string[] | string): string {
        if (typeof serviceNames === 'string') { serviceNames = [serviceNames]; }

        const namespaces = new Map<string, string[]>();
        const addedTypes = new Set<string>();

        serviceNames.forEach(fullName => {
            const [ packageName, serviceName ] = fullName.split('.');

            const modType = (t: string) => {
                const parts = t.split('.');
                if (parts.length > 1 && parts[0] !== packageName) {
                    return `${parts[0]}.I${parts[1]}`;
                } else {
                    return `I${parts[parts.length - 1]}`;
                }
            };

            const convertType = (t: string) => {
                // Check custom types first
                const customType = getCustomType(t);
                if (customType) {
                    return customType.tsType;
                }

                if (['double', 'float', 'int32', 'uint32', 'sint32', 'fixed32', 'sfixed32', 'int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'].indexOf(t) !== -1)
                    return 'number';
                else if (t === 'string')
                    return 'string';
                else if (t === 'bool')
                    return 'boolean';
                else if (t === 'bytes')
                    return 'Buffer';
                else
                    return undefined;
            };

            const addType = (typeName: string) => {
                if (typeName.startsWith('.')) { typeName = typeName.slice(1); }
                if (addedTypes.has(typeName)) return;
                addedTypes.add(typeName);
                const parts = typeName.split('.');
                const ns = parts.length === 2 ? parts[0] : packageName;
                const messageName = parts[parts.length - 1];
                const target = namespaces.get(ns) || namespaces.set(ns, []).get(ns);

                const T = this.root.lookupType(typeName);
                if (!T) {
                    throw new Error('could not find the type ' + typeName + ' you are trying to add');
                }

                target.push(`    export interface ${modType(messageName)} {`);
                const newTypes = new Set<string>();
                T.fieldsArray.forEach(field => {
                    let t = convertType(field.type);
                    if (!t) {
                        if (field.type !== typeName) {
                            newTypes.add(field.type);
                        }
                        t = modType(field.type);
                    }
                    target.push(`        ${field.name}${!field.required ? '?' : ''}: (${t}${field.repeated ? '[]' : ''} | null);`);
                });
                target.push('    }\n');
                newTypes.forEach(addType);
            };

            const serviceSource: string[] = [];
            serviceSource.push(`\n    export interface ${serviceName} {`);
            const service = this.root.lookupService(fullName);
            const methods = service.methodsArray;
            methods.forEach(method => {
                const req = method.requestType;
                const res = method.responseType;
                serviceSource.push(`        ${method.name}(request: ${modType(req)}): Promise<${modType(res)}>;`);
                addType(req);
                addType(res);
            });
            serviceSource.push('    }\n');
            const nsSource = namespaces.get(packageName);
            nsSource.push(serviceSource.join('\n'));
            namespaces.set(packageName, nsSource);
        });

        const source: string[] = [];
        namespaces.forEach((value: string[], key: string) => {
            source.push(`export namespace ${key} {`);
            source.push(value.join('\n'));
            source.push('}\n\n');
        });
        return source.join('\n');

    }
}
