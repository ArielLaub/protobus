import { IContext } from './context';
import { StreamOptions } from './message_dispatcher';
import { Logger } from './logger';

export class InvalidServiceNameError extends Error {}
export class AlreadyInitializedError extends Error {}
export class PublishMessageError extends Error {}
export class InvalidRequestError extends Error {}
export class InvalidResponseError extends Error {}

export default class ServiceProxy {
    private context: IContext;
    private isInitialized = false;
    private serviceName: string;

    constructor(context: IContext, serviceName: string) {
        this.serviceName = serviceName;
        this.context = context;
    }

    async init() {
        if (this.isInitialized) {
            Logger.error(`already initialized service proxy ${this.serviceName}`);
            throw new AlreadyInitializedError();
        }
        const root = this.context.factory.root;
        const TService = root.lookupService(this.serviceName);
        if (!TService) throw new InvalidServiceNameError();

        const TMethods = Object.keys(TService.methods);
        TMethods.forEach((name) => {
            const TMethod = TService.methods[name];

            // Proto method names are assigned straight onto this instance, so a
            // method called `init` or `isInitialized` would silently clobber the
            // proxy's own members. Fail loudly instead of half-working.
            if (name in this) {
                throw new InvalidServiceNameError(
                    `proto method '${this.serviceName}.${name}' collides with a ServiceProxy member; rename it in the .proto`,
                );
            }
            const methodFullName = `${this.serviceName}.${TMethod.name}`; // <package>.<service>.<method>

            // Branch at build time on whether the method is declared
            // server-streaming in its .proto. Streaming methods are exposed
            // as functions returning AsyncIterable<chunk>; unary methods are
            // exposed as async functions returning a single decoded result.
            if (this.context.factory.isStreamingMethod(methodFullName)) {
                // `options` is appended last so every existing call signature
                // keeps working unchanged.
                (<any>this)[TMethod.name] = (
                    requestMessage: any,
                    actor?: string,
                    idleTimeoutMs?: number,
                    options?: StreamOptions,
                ) => this._buildStreamingCall(
                    methodFullName, TMethod.requestType, requestMessage, actor, idleTimeoutMs, options,
                );
            } else {
                (<any>this)[TMethod.name] = async (requestMessage: any, actor?: string, rpc?: boolean, timeoutMs?: number) => {
                    let buffer;
                    try {
                        buffer = this.context.factory.buildRequest(methodFullName, requestMessage, actor);
                    } catch (error) {
                        // No payload in the log line — requests carry secrets and PII.
                        Logger.error(`failed building message '${TMethod.requestType}': ${(error as any)?.message ?? error}`);
                        throw new InvalidRequestError('failed parsing message');
                    }
                    return this.context.publishMessage(buffer, `REQUEST.${methodFullName}`, rpc, timeoutMs)
                        .catch((error) => {
                            Logger.error(error);
                            throw new PublishMessageError(`failed dispatching request to ${methodFullName}`);
                        })
                        .then((responseData) => {
                            if (rpc === false) {
                                Logger.debug('recieved non rpc result sending back empty answer');
                                return {};
                            }
                            let response;
                            try {
                                response = this.context.factory.decodeResponse(responseData);
                                Logger.debug(`received result for message ${methodFullName}`);
                            } catch (error) {
                                Logger.error(error);
                                throw new InvalidResponseError(`failed parsing result for ${methodFullName}`);
                            }
                            if (response.error) {
                                const err = new Error(response.error.message);
                                if (response.error.code) {
                                    (err as any).code = response.error.code;
                                }
                                throw err;
                            }

                            if (!response.result) {
                                throw new InvalidResponseError(
                                    `response for ${methodFullName} carried neither a result nor an error`,
                                );
                            }
                            return response.result.data;
                        });
                };
            }
        });
        this.isInitialized = true;
    }

    /**
     * Build an AsyncIterable that decodes each chunk and re-raises mid-stream
     * errors. The returned iterable is consumed with `for await`.
     */
    private _buildStreamingCall(
        methodFullName: string,
        requestType: string,
        requestMessage: any,
        actor: string | undefined,
        idleTimeoutMs: number | undefined,
        options?: StreamOptions,
    ): AsyncIterable<any> {
        const factory = this.context.factory;
        const context = this.context;

        let buffer: Buffer;
        try {
            buffer = factory.buildRequest(methodFullName, requestMessage, actor);
        } catch (error) {
            // Type and error only — the request object is application data and
            // must not reach the log.
            Logger.error(
                `failed building streaming request '${requestType}' for ${methodFullName}: ` +
                `${(error as any)?.message ?? error}`,
            );
            // Return an iterable whose first iteration throws — surfaces the
            // request-build error inside the caller's try/catch around `for await`.
            return {
                [Symbol.asyncIterator]() {
                    return {
                        async next(): Promise<IteratorResult<any>> {
                            throw new InvalidRequestError('failed parsing message');
                        },
                    };
                },
            };
        }

        const chunks = context.publishStreamingMessage(
            buffer,
            `REQUEST.${methodFullName}`,
            idleTimeoutMs,
            options,
        );

        return (async function* (): AsyncIterable<any> {
            for await (const chunkBuf of chunks) {
                let response;
                try {
                    response = factory.decodeResponse(chunkBuf);
                } catch (error) {
                    Logger.error(error as any);
                    throw new InvalidResponseError(`failed parsing streaming chunk for ${methodFullName}`);
                }

                // Terminal chunks may carry an error instead of a result.
                if (response.error) {
                    const err = new Error(response.error.message);
                    if (response.error.code) {
                        (err as any).code = response.error.code;
                    }
                    throw err;
                }

                if (response.result) {
                    yield response.result.data;
                }
            }
        })();
    }
}