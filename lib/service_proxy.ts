import { IContext } from './context';
import { StreamOptions, CallOptions } from './message_dispatcher';
import { Logger } from './logger';

export class InvalidServiceNameError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'InvalidServiceNameError';
    }
}
export class AlreadyInitializedError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'AlreadyInitializedError';
    }
}
export class InvalidRequestError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'InvalidRequestError';
    }
}
export class InvalidResponseError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'InvalidResponseError';
    }
}

export default class ServiceProxy {
    private context: IContext;
    private isInitialized = false;
    private serviceName: string;
    /**
     * The service as the .proto declares it, which is not always the name the
     * proxy was constructed with: instances sharing one schema are addressed
     * under distinct runtime names, so `Combat.Player.player6` serves the
     * contract `Combat.Player`. Resolved the same way MessageService resolves
     * its own, so the two agree by construction.
     */
    private contractServiceName: string | undefined;

    constructor(context: IContext, serviceName: string) {
        this.serviceName = serviceName;
        this.context = context;
    }

    /**
     * Find the contract this proxy addresses, by trimming runtime segments off
     * the name until one names a service in the root.
     *
     * `Combat.Player.player6` is in no schema; `Combat.Player` is. Looking the
     * name up verbatim meant an instance-named service could not be proxied at
     * all — the only way to reach one was a hand-built routing key through
     * `context.publishMessage`, giving up the typed proxy entirely.
     */
    private resolveContract(): string {
        const factory = this.context.factory;
        // An uninitialised factory has no root, so hasService() answers false
        // for everything and the trim below would blame the .proto for a
        // schema that was simply never loaded.
        if (!factory.root) {
            throw new InvalidServiceNameError(
                `cannot resolve '${this.serviceName}': the message factory has not been ` +
                'initialised, so no schema is loaded yet. Await Context.init() before ' +
                'constructing a proxy.',
            );
        }
        let candidate = this.serviceName;
        for (;;) {
            if (factory.hasService(candidate)) {
                if (candidate !== this.serviceName) {
                    // Said out loud, because trimming is a guess. A name whose
                    // intended service is absent but which has an unrelated
                    // service as a prefix resolves to that ancestor and takes
                    // ITS method set — every call then fails with
                    // UnroutableError, because the server binds
                    // REQUEST.<ServiceName>.* and that is a single-segment
                    // wildcard. One line at startup is the difference between
                    // that and a mystery.
                    Logger.info(
                        `service proxy '${this.serviceName}' resolved to contract ` +
                        `'${candidate}'; requests will route to REQUEST.${this.serviceName}.*`,
                    );
                }
                return candidate;
            }
            const cut = candidate.lastIndexOf('.');
            if (cut <= 0) {
                throw new InvalidServiceNameError(
                    `no service in the schema matches '${this.serviceName}' or any prefix of it; ` +
                    'the .proto must declare the service this proxy addresses',
                );
            }
            candidate = candidate.slice(0, cut);
        }
    }

    async init() {
        if (this.isInitialized) {
            Logger.error(`already initialized service proxy ${this.serviceName}`);
            throw new AlreadyInitializedError();
        }
        // hasService() first, then lookupService(): protobufjs THROWS a plain
        // `no such Service` from lookupService, so the `if (!TService)` guard
        // below could never run and InvalidServiceNameError was unreachable.
        this.contractServiceName = this.resolveContract();
        const root = this.context.factory.root;
        const TService = root.lookupService(this.contractServiceName);
        if (!TService) throw new InvalidServiceNameError(`no such service ${this.contractServiceName}`);

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
            // The two names play different parts and cannot be one string.
            //
            // The ENVELOPE carries the contract method name, because that is
            // what the receiving MessageService validates the body against and
            // what selects the schema the payload is read with.
            //
            // The ROUTING KEY carries the runtime name, because that is what
            // reaches this instance's queue. They are identical whenever the
            // proxy was constructed with a plain contract name.
            const methodFullName = `${this.contractServiceName}.${TMethod.name}`; // <package>.<service>.<method>
            const routingKey = `REQUEST.${this.serviceName}.${TMethod.name}`;

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
                    methodFullName, routingKey, TMethod.requestType, requestMessage,
                    actor, idleTimeoutMs, options,
                );
            } else {
                // `options` is appended last, so every existing call signature
                // keeps working unchanged — the same shape the streaming
                // branch above uses for StreamOptions.
                (<any>this)[TMethod.name] = async (
                    requestMessage: any,
                    actor?: string,
                    rpc?: boolean,
                    timeoutMs?: number,
                    options?: CallOptions,
                ) => {
                    let buffer;
                    try {
                        buffer = this.context.factory.buildRequest(methodFullName, requestMessage, actor);
                    } catch (error) {
                        // No payload in the log line — requests carry secrets and PII.
                        Logger.error(`failed building message '${TMethod.requestType}': ${(error as any)?.message ?? error}`);
                        throw new InvalidRequestError('failed parsing message');
                    }
                    // The delivery error is raised as it stands. Collapsing
                    // everything into one PublishMessageError threw away the
                    // distinction the whole publish path exists to report:
                    // UnroutableError and PublishNackedError are definite
                    // failures a caller may safely retry, while
                    // PublishConfirmTimeoutError and ChannelClosedError are
                    // ambiguous and retrying either can duplicate. The
                    // messageId that makes deduplication possible rides on the
                    // error too. See docs/advanced/security.md.
                    return this.context.publishMessage(buffer, routingKey, rpc, timeoutMs, options)
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
        routingKey: string,
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
            routingKey,
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