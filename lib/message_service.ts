import { Logger } from './logger';
import { IContext } from './context';
import MessageListener from './message_listener';
import EventListener, { EventHandler } from './event_listener';
import * as express from 'express';
import * as fs from 'fs';

export class InvalidResultError extends Error {}
export class InvalidMethodError extends Error {}
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
    routeHttp(): Promise<express.Express>;
}

export interface IMessageServiceOptions {
    maxConcurrent?: number;
}

export default abstract class MessageService implements IMessageService {
    protected context: IContext;

    private listener: MessageListener;
    private eventListener: EventListener;

    constructor (context: IContext, options: IMessageServiceOptions = {}) {
        this.context = context;
        this.listener = new MessageListener(context.connection, !!options.maxConcurrent, options.maxConcurrent);
        this.eventListener = new EventListener(context.connection, context.factory);
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

    public async init(): Promise<void> {
        try {
            await this.listener.init(this._onMessage.bind(this), this.ServiceName);
            await this.eventListener.init(undefined, `${this.ServiceName}.Events`);
            await this.listener.subscribe(`REQUEST.${this.ServiceName}.*`);
            await this.listener.start();
            await this.eventListener.start();
        } catch (err) {
            Logger.error(`error initializing service ${this.ServiceName} - ${err}\n${err.stack}`);
            throw err;
        }
    }

    // any service thats needs an http interface can create and bind an express
    // app in this method.
    public async routeHttp(): Promise<express.Express> {
        return undefined;
    }

    // core handler for incoming RPC requests made to REQUEST.<service name>.*
    private async _onMessage(data: any, id: string) {
        const request = this.context.factory.decodeRequest(data);
        const method = request.method.split('.')[2]; // <package>.<service>.<method>
        Logger.debug(`received request ${request.method} (${id})`);
        try {
            if ((<any> this)[method] && typeof (<any> this)[method] === 'function') {
                const p = (<any>this)[method](request.data, request.actor, id);
                if (!p || !p.then) {
                    throw new InvalidResultError(p);
                }

                const result = await p;
                Logger.debug(`sending result ${request.method} (${JSON.stringify(result)})`);
                return this.context.factory.buildResponse(request.method, result);
            } else {
                throw new InvalidMethodError(`invalid service method ${method}`);
            }
        } catch (error) {
            if (error) {
                Logger.error(error.stack || error.message);
            } else {
                Logger.error('null error received');
            }
            return this.context.factory.buildResponse(request.method, error);
        }
    }
}
