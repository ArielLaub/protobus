import * as cuid from 'cuid';
import { EventEmitter } from 'events';

import { IConnection, Channel, ConsumeOptions, MessageHandler } from './connection';
import { Logger,  ILogger } from './logger';

export class ConnectionError extends Error {}
export class NotConnectedError extends Error {}
export class NotInitializedError extends Error {}
export class AlreadyStartedError extends Error {}
export class MissingExchangeError extends Error {}

export abstract class BaseListener extends EventEmitter {
    protected connection: IConnection;

    protected queueName: string;
    protected exchangeName: string;
    protected exchangeType: string;
    protected channel: Channel;
    protected consumerTag: string;
    protected handler: MessageHandler;
    protected isAnonymous: boolean;
    protected lateAck: boolean;
    protected maxConcurrent: number;
    protected defaultHandler: MessageHandler;

    constructor(connection: IConnection) {
        super();

        this.connection = connection;
        this.queueName = '';
        this.exchangeName = '';
        this.exchangeType = '';
        this.consumerTag = '';
        this.handler = undefined;
        this.isAnonymous = true;
        this.lateAck = false;
        this.maxConcurrent = undefined; // only used for late ack workers.
        this.defaultHandler = async (message: Buffer/*, correlationId: string*/) => {
            Logger.warn(`unhandled message by default handler ${JSON.stringify(message)}`);
        };
    }

    get isConnected() { return this.connection.isConnected; }

    async init(messageHandler: MessageHandler, queueName?: string) {
        if (this.channel) return;
        if (!this.exchangeName) throw new MissingExchangeError();
        if (!this.connection.isConnected) throw new ConnectionError();
        this.handler = messageHandler || this.defaultHandler.bind(this);
        this.isAnonymous = !queueName;
        this.channel = await this.connection.openChannel();
        if (this.lateAck) { // support late ack worker services.
            await this.channel.prefetch(this.maxConcurrent, false);
        }
        await this.connection.declareExchange(this.channel, this.exchangeName, this.exchangeType, {
            autoDelete: false,
            durable: true,
            internal: false,
            arguments: {}
        });
        this.queueName = await this.connection.declareQueue(this.channel, queueName, {
            autoDelete: this.isAnonymous,
            durable: !this.isAnonymous,
            exclusive: this.isAnonymous,
            arguments: {}
        });
        // for direct exchange listeners we can go ahead and bind the queue.
        if (this.exchangeType === 'direct') {
            await this.connection.bindQueue(this.channel, this.queueName, this.exchangeName, this.queueName, {});
        }

        this.emit('initialized', {});
    }

    async start() {
        if (!this.channel) throw new NotInitializedError();
        if (this.consumerTag) throw new AlreadyStartedError();
        if (!this.connection.isConnected) throw new NotConnectedError();
        this.consumerTag = cuid();
        try {
            const options: ConsumeOptions = {
                consumerTag: this.consumerTag,
                noAck: false,
                exclusive: this.isAnonymous,
                noLocal: false,
                arguments: {}
            };
            await this.connection.consume(this.channel, this.queueName, this.handler, options, this.lateAck);
            this.emit('started', {});
        } catch (error) {
            if (error instanceof AlreadyStartedError) {
                Logger.warn('service already running. ignoring call to start.');
                return;
            }
            throw error;
        }
    }

    async close() {
        if (!this.channel || !this.queueName) throw new NotInitializedError();
        if (!this.connection.isConnected) throw new NotConnectedError();
        await this.connection.cancel(this.channel, this.consumerTag);

        await this.connection.closeChannel(this.channel);

        // cleanup
        this.consumerTag = '';
        this.channel = undefined;
        this.handler = undefined;
        this.queueName = '';
    }
}
