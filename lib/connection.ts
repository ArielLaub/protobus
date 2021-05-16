import * as amqplib from 'amqplib';
import { EventEmitter } from 'events';

import Config from './config';
import { Logger } from './logger';

export class AlreadyConnectedError extends Error {}
export class TimeoutError extends Error {}

export type Channel = amqplib.Channel;
export type ConsumeOptions = amqplib.Options.Consume;
export type PublishOptions = amqplib.Options.Publish;
export type AssertQueueOptions = amqplib.Options.AssertQueue;
export type AssertExchangeOptions = amqplib.Options.AssertExchange;
export type MessageHandler =  (content: Buffer, correlationId: string) => Promise<Buffer | void>;

export interface IConnection {
    isConnected: boolean;

    connect(url: string): Promise<amqplib.Connection>;
    disconnect(): Promise<any>;
    openChannel(): Promise<Channel>;
    closeChannel(channel: Channel): Promise<any>;
    declareExchange(channel: Channel, exchange: string, type: string, options: AssertExchangeOptions): Promise<any>;
    declareQueue(channel: Channel, queueName: string, options: AssertQueueOptions): Promise<any>;
    bindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any>;
    unbindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any>;
    deleteQueue(channel: Channel, queueName: string): Promise<any>;
    ack(channel: Channel, message: amqplib.Message, upTo?: boolean): Promise<any>;
    reject(channel: Channel, message: amqplib.Message, requeue?: boolean): Promise<any>;
    consume(channel: Channel, queueName: string, messageHandler: MessageHandler, options: ConsumeOptions, lateAck: boolean): Promise<any>;
    cancel(channel: Channel, consumerTag: string): Promise<any>;
    purgeQueue(channel: Channel, queueName: string): Promise<any>;
    publish(channel: Channel, exchangeName: string, routingKey: string, content: Buffer, properties: PublishOptions): Promise<any>;
}

export default class Connection extends EventEmitter {
    private handle: amqplib.Connection;

    private _isConnected: boolean;
    public get isConnected() {
        return this._isConnected;
    }

    async connect(url: string): Promise<amqplib.Connection> {
        if (this.isConnected) throw new AlreadyConnectedError();
        Logger.info('connecting to bus - ' + url);
        this.handle = await amqplib.connect(url);
        this._isConnected = true;
        Logger.info('connected to message bus');
        return this.handle;
    }

    async disconnect(): Promise<any> {
        await this.handle.close();
        this._isConnected = false;
        return;
    }

    async openChannel(): Promise<Channel> {
        return this.handle.createChannel();
    }

    async closeChannel(channel: Channel): Promise<any> {
        return channel.close();
    }

    async declareExchange(channel: Channel, exchange: string, type: string, options: AssertExchangeOptions): Promise<any> {
        return channel.assertExchange(exchange, type, options);
    }

    async declareQueue(channel: Channel, queueName: string, options: AssertQueueOptions): Promise<any> {
        const result = await channel.assertQueue(queueName, options);
        return result.queue;
    }

    async bindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any> {
        return channel.bindQueue(queue, exchange, routingKey, args);
    }

    async unbindQueue(channel: Channel, queue: string, exchange: string, routingKey: string, args: any): Promise<any> {
        return channel.unbindQueue(queue, exchange, routingKey, args);
    }

    async deleteQueue(channel: Channel, queueName: string): Promise<any> {
        return channel.deleteQueue(queueName);
    }

    async ack(channel: Channel, message: amqplib.Message, upTo?: boolean): Promise<any> {
        return channel.ack(message, upTo);
    }

    async reject(channel: Channel, message: amqplib.Message, requeue?: boolean): Promise<any> {
        return channel.reject(message, requeue);
    }

    async consume(channel: Channel, queueName: string, messageHandler: MessageHandler, options: ConsumeOptions, lateAck: boolean): Promise<any> {
        const onMessage = async (msg: amqplib.Message) => {
            const replyTo = msg.properties.replyTo;
            const correlationId = msg.properties.correlationId;

            Logger.debug(`incoming message: ${JSON.stringify(msg.fields)}`);

            if (!options.noAck && !lateAck) { // early ackers never reject and immidiately ack
                await this.ack(channel, msg);
            }

            let timeout;
            return new Promise(async (resolve: any, reject: any) => {
                // set timeout for RPC calls that do not resolve
                timeout = setTimeout(() => {
                    reject(new TimeoutError(`message ${correlationId} timed out`));
                }, Config.messageProcessingTimeout);
                const result = await messageHandler(msg.content, correlationId);
                // clear timeout once result is received
                clearTimeout(timeout);
                if (!options.noAck && lateAck) { // late ackers ack when processing is done
                    await this.ack(channel, msg);
                }
                if (replyTo) {
                    const p = {
                        contentType: 'application/octet-stream',
                        correlationId,
                    };
                    if (result) {
                        await this.publish(channel, Config.callbacksExchangeName, replyTo, result, p);
                    }
                }
                resolve();
            }).catch(async err => {
                // clear timeout so we don't get 2 errors for the same message
                clearTimeout(timeout);
                Logger.error(`unhandled error consuming bus message - ${err.message || err}:\n${err.stack}`);

                if (!options.noAck && lateAck) { // late ackers reject on error instead of acking. same as nack
                    const requeue = !!err.external;
                    Logger.warn(`${requeue ? 'requeuing' : 'rejecting'} message ${correlationId}`);
                    await this.reject(channel, msg, requeue);
                }
            });
        };
        await channel.consume(queueName, onMessage, options);
    }

    async cancel(channel: Channel, consumerTag: string): Promise<any> {
        return channel.cancel(consumerTag);
    }

    async purgeQueue(channel: Channel, queueName: string): Promise<any> {
        return channel.purgeQueue(queueName);
    }

    async publish(channel: Channel, exchangeName: string,
      routingKey: string, content: Buffer, properties: PublishOptions): Promise<any> {
        channel.publish(exchangeName, routingKey, content, properties);
    }
}
