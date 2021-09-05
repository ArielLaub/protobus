const cuid = require('cuid');

import { IConnection, Channel, PublishOptions } from './connection';
import Config from './config';
import { Logger } from './logger';
import CallbackListener from './callback_listener';

export class NotConnectedError extends Error {}

interface CallbackEntry {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
}

export interface IMessageDispatcher {
    isInitialized: boolean;
    init(): Promise<any>;
    publish(content: any, routingKey: string, rpc: boolean): Promise<any>;
}

export default class MessageDispatcher implements IMessageDispatcher {
    private connection: IConnection;
    private callbacks: Map<string, CallbackEntry>;
    private callbackListener: any;
    private channel: Channel;

    private _isInitialized: boolean = false;
    public get isInitialized() { return this._isInitialized; }

    constructor(connection: IConnection) {
        this.connection = connection;

        this.callbacks = new Map<string, CallbackEntry>();
        this.callbackListener = new CallbackListener(this.connection);

    }

    async _onResult(content: any, id: string) {
        // if there is a waiting promise resolve/reject it
        if (this.callbacks.has(id)) {
            const callback = this.callbacks.get(id);
            this.callbacks.delete(id);
            Logger.debug(`received result for message ${id}`);
            Logger.debug(content);
            await callback.resolve(content);
        }
    }

    async init(): Promise<any> {
        if (this.isInitialized) return;
        this.channel = await this.connection.openChannel();
        await this.callbackListener.init(this._onResult.bind(this));
        await this.callbackListener.start();
        this._isInitialized = true;
    }

    async publish(content: any, routingKey: string, rpc: boolean): Promise<Buffer> {
        if (!this.connection.isConnected) throw new NotConnectedError();

        if (rpc !== false) {
            rpc = true;
        }

        const id = cuid();
        const properties: PublishOptions = {
            contentType: 'application/octet-stream',
            correlationId: id,
            replyTo: rpc ? this.callbackListener.callbackQueue : undefined,
            deliveryMode: 2, // persistent
        };
        // this is called syncronously and _onResult resolves/rejects it later

        await this.connection.publish(this.channel, Config.busExchangeName, routingKey, content, properties);

        if (!rpc) return; // we are not expecting any result so resolve

        return new Promise<Buffer>((resolve: any, reject: any) => {
            this.callbacks.set(id, { resolve, reject } );
        });
    }
}
