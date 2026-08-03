import MessageService from './message_service';
import { IContext } from './context';
import { Logger } from './logger';

// static proto interface, the instance interface is IMessageService
export type ServiceType<T extends MessageService> = {
    new (context: IContext): T
};

let deprecationWarned = false;

/**
 * @deprecated Run one service per process instead.
 *
 * Node is single-threaded, so co-locating services in one process buys no
 * parallelism — it just couples their failure domains and their deploys. A
 * `MessageService` now registers its own schema during `init()`, so there is
 * nothing left that ServiceCluster is needed for:
 *
 * ```typescript
 * // instead of: new ServiceCluster(context).use(MyService)
 * await RunnableService.start(context, MyService);
 * ```
 *
 * Retained purely so existing imports keep compiling. It also cannot pass
 * IMessageServiceOptions through to its services, which means retry, DLQ and
 * prefetch tuning are all unreachable via this API.
 */
export default class ServiceCluster {
    private context: IContext;
    private services: MessageService[];

    constructor(context: IContext) {
        this.services = [];
        this.context = context;

        if (!deprecationWarned) {
            deprecationWarned = true;
            Logger.warn(
                'ServiceCluster is deprecated and will be removed in a future major version. ' +
                'Run one service per process (RunnableService.start) — services now register ' +
                'their own schema, and ServiceCluster cannot pass retry/prefetch options through.',
            );
        }
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
