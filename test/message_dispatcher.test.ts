import * as amqplib from 'amqplib';
import * as protobuf from 'protobufjs';
import { expect } from 'chai';

import MessageDispatcher from '../lib/message_dispatcher';
import Connection, { Channel } from '../lib/connection';
import Config from '../lib/config';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('MessageDispatcher tests suite', () => {
    let dispatcher: MessageDispatcher;
    let channel: Channel;
    let connection: Connection;

    before(async () => {
        try {
            connection = new Connection();
            await connection.connect(AMQP_CONNECTION_STRING);
            channel = await connection.openChannel();
            dispatcher = new MessageDispatcher(connection);
            await dispatcher.init();
            expect(dispatcher).to.have.property('isInitialized', true);
        }
        catch (error) {
            console.error(error);
        }
    });

    it('should publish RPC and wait for result', async () => {
        const routingKey = 'TEST.SERVICE.METHOD';
        const queue = await connection.declareQueue(channel, undefined, {
            durable: false,
            exclusive: true,
            autoDelete: true
        });
        await connection.bindQueue(channel, queue, Config.busExchangeName, routingKey, {});
        const handler = async (content: Buffer, correlationId: string) => {
            expect(content.toString()).to.equal('test content');
            return new Buffer('test result');
        };
        await connection.consume(channel, queue, handler, {
            noAck: false,
            noLocal: false
        }, true);
        const result = await dispatcher.publish(new Buffer('test content'), routingKey, true);
        expect(result.toString()).to.equal('test result');
    });

    it('should not wait for result on non RPC', async () => {
        const routingKey = 'TEST.SERVICE.METHOD2';
        const queue = await connection.declareQueue(channel, undefined, {
            durable: false,
            exclusive: true,
            autoDelete: true
        });
        await connection.bindQueue(channel, queue, Config.busExchangeName, routingKey, {});
        let alreadyReturned = false; // we set this to true after sending out the call
        let messageProcessed = false;
        const promise = new Promise(async (resolve) => {
            const handler = async (content: Buffer, correlationId: string) => {
                messageProcessed = true;
                expect(content.toString()).to.equal('fire and forget');
                // check that call on the sender side was returned without waiting
                expect(alreadyReturned).to.be.true;
                resolve(null);
                return new Buffer('going nowhere');
            };
            await connection.consume(channel, queue, handler, {
                noAck: false,
                noLocal: false
            }, true);
        });
        const result = await dispatcher.publish(new Buffer('fire and forget'), routingKey, false);
        alreadyReturned = true;
        expect(messageProcessed).to.be.false;
        expect(result).to.not.exist;
        await promise;
        expect(messageProcessed).to.be.true;
    });
});

