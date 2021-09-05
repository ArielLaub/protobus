import { IContext } from './context';
import { Logger, ILogger } from './logger';

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
            (<any>this)[TMethod.name] = async (requestMessage: any, actor: string, rpc: boolean) => {
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
                        if (!rpc) {
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
                        if (response.error) { throw new Error(response.error.message); }

                        return response.result.data;
                    });
            };
        });
        this.isInitialized = true;
    }
}