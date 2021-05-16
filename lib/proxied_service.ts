import MessageService from './message_service';
import ServiceProxy from './service_proxy';

// a message service with a strongly typed internal proxy instance
// due to TS limitations the declaration of such a child service would be
// class MyService extends ProxiedMessageService<IMyService> implements IMyService { ... }
// notice that the interface is specified twice which is not ideal..
export default abstract class ProxiedService<T> extends MessageService {
    private _proxy: T;
    public get proxy(): T { return this._proxy; }

    async init(): Promise<void> {
        await super.init();

        const proxy = new ServiceProxy(this.context, this.ServiceName);
        await proxy.init();
        this._proxy = <T><any>proxy;
    }
}