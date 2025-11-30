import { createId } from '@paralleldrive/cuid2';

import MessageListener from '../../lib/message_listener';
import Connection, { Channel } from '../../lib/connection';
import Config from '../../lib/config';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('MessageListener tests suite', () => {
    let connection: Connection;
    let channel: Channel;

    beforeAll(async () => {
        connection = new Connection();
        await connection.connect(AMQP_CONNECTION_STRING);
        channel = await connection.openChannel();
    });

    afterAll(async () => {
        if (connection && connection.isConnected) {
            await connection.disconnect();
        }
    });

    it('should receive a message listener subscribed to', async () => {
        await new Promise<void>(async (resolve) => {
            const correlationId = createId();
            const listener = new MessageListener(connection);
            const handler = async (content: Buffer, id: string) => {
                expect(content.toString()).toBe('test 123');
                expect(id).toBe(correlationId);
                resolve();
            };
            await listener.init(handler);
            await listener.subscribe('REQUEST.TEST.SERVICE.*');
            await listener.start();
            await connection.publish(channel, Config.busExchangeName, 'REQUEST.TEST.SERVICE.METHOD', Buffer.from('test 123'), {
                contentType: 'application/octet-stream',
                correlationId
            });
        });
    });
});
