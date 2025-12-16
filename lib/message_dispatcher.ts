import { randomUUID } from 'crypto';

import { IConnection, Channel, PublishOptions } from './connection';
import Config from './config';
import { Logger } from './logger';
import CallbackListener from './callback_listener';

export class NotConnectedError extends Error {}
export class DisconnectedError extends Error {
    constructor() {
        super('Connection lost during RPC call');
    }
}

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
    private callbackListener: CallbackListener;
    private channel: Channel;

    private _isInitialized: boolean = false;
    public get isInitialized() { return this._isInitialized; }
    private _boundOnReconnected: () => void;
    private _boundOnDisconnected: () => void;

    constructor(connection: IConnection) {
        this.connection = connection;

        this.callbacks = new Map<string, CallbackEntry>();
        this.callbackListener = new CallbackListener(this.connection);

        // Listen for connection events (store bound refs for proper cleanup)
        this._boundOnReconnected = this._onReconnected.bind(this);
        this._boundOnDisconnected = this._onDisconnected.bind(this);
        this.connection.on('disconnected', this._boundOnDisconnected);
        this.connection.on('reconnected', this._boundOnReconnected);
    }

    /**
     * Called when connection is lost - reject all pending callbacks
     */
    private _onDisconnected(): void {
        Logger.debug('MessageDispatcher: connection lost, rejecting pending callbacks');
        this.channel = undefined;

        // Reject all pending RPC callbacks
        const error = new DisconnectedError();
        for (const [_id, callback] of this.callbacks) {
            callback.reject(error);
        }
        this.callbacks.clear();
    }

    /**
     * Called when connection is re-established
     */
    private async _onReconnected(): Promise<void> {
        if (!this._isInitialized) return;

        Logger.info('MessageDispatcher: reconnected, re-initializing channel');

        try {
            this.channel = await this.connection.openChannel();
            // CallbackListener handles its own reconnection via BaseListener
            Logger.info('MessageDispatcher: successfully re-initialized after reconnection');
        } catch (err) {
            Logger.error(`MessageDispatcher: failed to re-initialize after reconnection: ${err.message}`);
        }
    }

    async _onResult(content: any, id: string) {
        // if there is a waiting promise resolve/reject it
        if (this.callbacks.has(id)) {
            const callback = this.callbacks.get(id);
            this.callbacks.delete(id);
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

        const id = randomUUID();
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

    async close(): Promise<void> {
        this.connection.removeListener('disconnected', this._boundOnDisconnected);
        this.connection.removeListener('reconnected', this._boundOnReconnected);
        await this.callbackListener.close();
    }
}
