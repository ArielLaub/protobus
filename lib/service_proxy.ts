import { IContext } from './context';
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
            const methodFullName = `${this.serviceName}.${TMethod.name}`; // <package>.<service>.<method>

            // Branch at build time on whether the method is declared
            // server-streaming in its .proto. Streaming methods are exposed
            // as functions returning AsyncIterable<chunk>; unary methods are
            // exposed as async functions returning a single decoded result.
            if (this.context.factory.isStreamingMethod(methodFullName)) {
                (<any>this)[TMethod.name] = (requestMessage: any, actor?: string, idleTimeoutMs?: number) =>
                    this._buildStreamingCall(methodFullName, TMethod.requestType, requestMessage, actor, idleTimeoutMs);
            } else {
                (<any>this)[TMethod.name] = async (requestMessage: any, actor?: string, rpc?: boolean) => {
                    let buffer;
                    try {
                        buffer = this.context.factory.buildRequest(methodFullName, requestMessage, actor);
                    } catch (error) {
                        Logger.error(`failed building message '${TMethod.requestType}' from ${JSON.stringify(requestMessage)}\n${error}`);
                        throw new InvalidRequestError('failed parsing message');
                    }
                    return this.context.publishMessage(buffer, `REQUEST.${methodFullName}`, rpc)
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
                                Logger.debug(JSON.stringify(response, undefined, 4));
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
    ): AsyncIterable<any> {
        const factory = this.context.factory;
        const context = this.context;

        let buffer: Buffer;
        try {
            buffer = factory.buildRequest(methodFullName, requestMessage, actor);
        } catch (error) {
            Logger.error(`failed building streaming request '${requestType}' from ${JSON.stringify(requestMessage)}\n${error}`);
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