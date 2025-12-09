import * as fs from 'fs';
import * as path from 'path';
import * as protoBuf from 'protobufjs';
import { Type, Field, OneOf, Message } from 'protobufjs/light';
import { Logger } from './logger';
import {
    ICustomType,
    registerCustomType,
    getCustomType,
    isCustomType,
    getCustomTypeNames,
    BigIntMessage,
    TimestampMessage
} from './custom_types';

export class MessageTypeRequiredError extends Error {}
export class NotInitializedError extends Error {}

(<any>protoBuf.parse).defaults.keepCase = true;

// Re-export custom types functionality
export { ICustomType, registerCustomType, getCustomType, isCustomType, getCustomTypeNames };
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

        if (stat.isDirectory()) { childDirs.push(fullName); } else if (filename.indexOf(filter) !== -1) { filtered.push(fullName); }
    });

    childDirs.forEach((fullName) => {
        console.warn(fullName);
        findFiles(fullName, filter, filtered);
    });

    return filtered;
}

function uintArrayToBuffer(arr: Uint8Array): Buffer {
    const buf = Buffer.from(arr.buffer);
    if (arr.byteLength !== arr.buffer.byteLength) {
        return buf.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
    } else {
        return buf;
    }
}

export default class MessageFactory {
    public root: protoBuf.Root;
    private isInitialized: boolean = false;
    private registeredTypes: Map<string, typeof Message> = new Map();

    constructor() {
    }

    private getMethodType(fullName: string): protoBuf.Method  {
        const nameParts = fullName.split('.');
        const serviceName = `${nameParts[0]}.${nameParts[1]}`;
        const methodName = nameParts[2];
        const TService = this.root.lookupService(serviceName);
        return TService.methods[methodName];
    }

    /**
     * Register a custom type with this MessageFactory instance.
     * The type will be available for use in .proto files.
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
        if (fileNames.length) {
            Logger.info(`loading proto files:\n ${JSON.stringify(fileNames)}`);
            const root  = protoBuf.loadSync(fileNames);
            this.root = root;
        } else {
            this.root = new protoBuf.Root({ keepCase: true });
        }

        // Register built-in custom types
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

        this.isInitialized = true;
        Logger.debug('message factory initialized');
    }

    public parse(proto: string, moduleName?: string): void {
        if (moduleName) {
            (<any>protoBuf.parse).filename = moduleName;
        }
        protoBuf.parse(proto, this.root, { keepCase: true });
    }

    public decodeMessage(messageType: string, data: Buffer) {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');
        if (!messageType) throw new MessageTypeRequiredError('message type required');
        const Message = this.root.lookupType(messageType);

        try {
            return Message.toObject(Message.decode(data), { arrays: true, enums: String });
        } catch (error) {
            Logger.error(Message.verify(data));
            Logger.error(`error decoding message ${messageType} with data ${JSON.stringify(data)}`);
            throw error;
        }
    }

    public buildRequest(methodFullName: string, obj: any, actor: string): Buffer {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');

        const TMethod = this.getMethodType(methodFullName);
        const messageType = TMethod.requestType;
        const Message = this.root.lookupType(messageType);
        try {
            const processed = preprocessForEncode(obj, Message, this.registeredTypes);
            const request = RequestContainer.create({
                method: methodFullName,
                actor,
                data: Message.encode(Message.create(processed)).finish()
            });
            return uintArrayToBuffer(RequestContainer.encode(request).finish());
        } catch (error) {
            Logger.error(Message.verify(obj));
            Logger.error(`error building request ${messageType} with data ${JSON.stringify(obj)}`);
            throw error;
        }
    }

    public decodeRequest(data: Buffer): IRequestContainer {
        const request = RequestContainer.decode(data);
        const TMethod = this.getMethodType(request.method);
        const result = request.toJSON();
        const messageType = TMethod.requestType;
        result.data = this.decodeMessage(messageType, request.data);
        return {
            method: result.method,
            data: this.decodeMessage(messageType, request.data),
            actor: result.actor
        };
    }

    public buildResponse(methodFullName: string, obj: any): Buffer {
        if (!this.isInitialized) throw new NotInitializedError('message factory not initialized');
        let response = undefined;
        const TMethod = this.getMethodType(methodFullName);
        const messageType = TMethod.responseType;

        if (obj instanceof Error) {
            response = ResponseContainer.create({
                error: ResponseError.create({
                    method: methodFullName,
                    message: obj.message,
                    code: (obj as any).code || ''
                }),
            });
        } else {
            const Message = this.root.lookupType(messageType);
            try {
                const processed = preprocessForEncode(obj, Message, this.registeredTypes);
                response = ResponseContainer.create({
                    result: ResponseResult.create({
                        method: methodFullName,
                        data: Message.encode(Message.create(processed)).finish(),
                    }),
                });
            } catch (error) {
                Logger.error(Message.verify(obj));
                Logger.error(`error building response message ${messageType} with data ${JSON.stringify(obj)}`);
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
            const processed = preprocessForEncode(obj, Event, this.registeredTypes);
            return uintArrayToBuffer(EventContainer.encode(EventContainer.create({
                type,
                topic,
                data: Event.encode(Event.create(processed)).finish(),
            })).finish());
        } catch (err) {
            Logger.error(Event.verify(obj));
            Logger.error(`failed building event message ${type}`);
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
