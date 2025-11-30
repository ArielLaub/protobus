import MessageDispatcher from '../../lib/message_dispatcher';
import Connection, { Channel } from '../../lib/connection';
import Config from '../../lib/config';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('MessageDispatcher tests suite', () => {
    let dispatcher: MessageDispatcher;
    let channel: Channel;
    let connection: Connection;

    beforeAll(async () => {
        connection = new Connection();
        await connection.connect(AMQP_CONNECTION_STRING);
        channel = await connection.openChannel();

        // Ensure the bus exchange exists (normally created by MessageListener)
        await connection.declareExchange(channel, Config.busExchangeName, 'topic', {
            autoDelete: false,
            durable: true,
            internal: false,
            arguments: {}
        });

        dispatcher = new MessageDispatcher(connection);
        await dispatcher.init();
        expect(dispatcher.isInitialized).toBe(true);
    });

    afterAll(async () => {
        if (connection && connection.isConnected) {
            await connection.disconnect();
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
        const handler = async (content: Buffer, _correlationId: string) => {
            expect(content.toString()).toBe('test content');
            return Buffer.from('test result');
        };
        await connection.consume(channel, queue, handler, {
            noAck: false,
            noLocal: false
        }, true);
        const result = await dispatcher.publish(Buffer.from('test content'), routingKey, true);
        expect(result.toString()).toBe('test result');
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
        const promise = new Promise<void>(async (resolve) => {
            const handler = async (content: Buffer, _correlationId: string) => {
                messageProcessed = true;
                expect(content.toString()).toBe('fire and forget');
                // check that call on the sender side was returned without waiting
                expect(alreadyReturned).toBe(true);
                resolve();
                return Buffer.from('going nowhere');
            };
            await connection.consume(channel, queue, handler, {
                noAck: false,
                noLocal: false
            }, true);
        });
        const result = await dispatcher.publish(Buffer.from('fire and forget'), routingKey, false);
        alreadyReturned = true;
        expect(messageProcessed).toBe(false);
        expect(result).toBeUndefined();
        await promise;
        expect(messageProcessed).toBe(true);
    });
});
