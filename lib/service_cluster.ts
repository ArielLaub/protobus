import MessageService from './message_service';
import { IContext } from './context';
import { Logger } from './logger';

// static proto interface, the instance interface is IMessageService
export type ServiceType<T extends MessageService> = {
    new (context: IContext): T
};

export default class ServiceCluster {
    private context: IContext;
    private services: MessageService[];

    constructor(context: IContext) {
        this.services = [];
        this.context = context;
    }

    public use<T extends MessageService>(Service: ServiceType<T>, count: number = 1): T {
        let service = <T>(new Service(this.context));
        this.context.factory.parse(service.Proto, service.ServiceName);
        for (let i = 0; i < count; ++i) {
            this.services.push(service);
            if (i < count - 1) {
                service = <T>(new Service(this.context));
            }
        }
        return service;
    }

    public async init() {
        for (let i = 0; i < this.services.length; ++i) {
            const service = this.services[i];
            Logger.info(`initializing service class ${service.ServiceName}`);
            await service.init();
        }
    }

    public get ServiceNames(): string[] {
        return this.services.map(s => s.ServiceName);
    }
}
