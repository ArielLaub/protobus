import * as amqplib from 'amqplib';
import * as protobuf from 'protobufjs';
import * as cuid from 'cuid';
import { expect } from 'chai';

import MessageListener from '../lib/message_listener';
import Connection, { Channel } from '../lib/connection';
import Config from '../lib/config';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('MessageDispatcher tests suite', () => {
    let connection: Connection;
    let channel: Channel;

    before(async () => {
        try {
            connection = new Connection();
            await connection.connect(AMQP_CONNECTION_STRING);
            channel = await connection.openChannel();
        }
        catch (error) {
            console.error(error);
        }
    });

    it('should receive a message listener subscribed to', async () => {
        const channnel = await connection.openChannel();
        await new Promise(async (resolve) => {
            const correlationId = cuid();
            const listener = new MessageListener(connection);
            const handler = async (content: Buffer, id: string) => {
                expect(content.toString()).to.equal('test 123');
                expect(id).to.equal(correlationId);
                resolve(null);
            };
            await listener.init(handler);
            await listener.subscribe('REQUEST.TEST.SERVICE.*');
            await listener.start();
            await connection.publish(channel, Config.busExchangeName, 'REQUEST.TEST.SERVICE.METHOD', new Buffer('test 123'), {
                contentType: 'application/octet-stream',
                correlationId
            });
        });
    });

});

