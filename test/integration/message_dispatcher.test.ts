import MessageDispatcher from '../../lib/message_dispatcher';
import Connection, { Channel } from '../../lib/connection';
import Config from '../../lib/config';
import { UnroutableError, PublishError } from '../../lib/errors';

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
        // How long the handler takes. The publish must not wait for it.
        const HANDLER_MS = 500;
        let handlerFinished = false;

        const processed = new Promise<void>(async (resolve) => {
            const handler = async (content: Buffer, _correlationId: string) => {
                expect(content.toString()).toBe('fire and forget');
                await new Promise((r) => setTimeout(r, HANDLER_MS));
                handlerFinished = true;
                resolve();
                return Buffer.from('going nowhere');
            };
            await connection.consume(channel, queue, handler, {
                noAck: false,
                noLocal: false
            }, true);
        });

        const started = Date.now();
        const result = await dispatcher.publish(Buffer.from('fire and forget'), routingKey, false);
        const elapsed = Date.now() - started;

        // A non-RPC publish waits for the broker to CONFIRM receipt, and
        // nothing more — no reply, and certainly not the handler's result.
        //
        // A quick handler may well run concurrently with the confirm
        // round-trip; that is fine. Not blocking on the handler is the
        // contract, not winning a race against the consumer.
        expect(result).toBeUndefined();
        expect(handlerFinished).toBe(false);
        expect(elapsed).toBeLessThan(HANDLER_MS);

        await processed;
        expect(handlerFinished).toBe(true);
    });

    /**
     * Publisher confirms against a real broker. Before confirms existed this
     * request was accepted into amqplib's write buffer, `publish()` resolved
     * happily, and the caller sat waiting out its entire RPC timeout for a
     * service that was never there.
     */
    it('fails fast with UnroutableError when no service is bound', async () => {
        const started = Date.now();

        let raised: any;
        try {
            await dispatcher.publish(
                Buffer.from('nobody is listening'),
                'TEST.SERVICE.NOTHING.IS.BOUND.HERE',
                true,
                20000, // RPC timeout; must NOT be what ends this call
            );
        } catch (err) {
            raised = err;
        }

        expect(raised).toBeInstanceOf(UnroutableError);
        expect(raised).toBeInstanceOf(PublishError);
        // Reported by the broker, not by waiting out the RPC deadline.
        expect(Date.now() - started).toBeLessThan(5000);
        // Carries the id a consumer would deduplicate on.
        expect(typeof raised.messageId).toBe('string');
    });

    it('does not leak a pending callback when the request is unroutable', async () => {
        await expect(
            dispatcher.publish(Buffer.from('x'), 'TEST.SERVICE.ALSO.NOT.BOUND', true, 20000),
        ).rejects.toBeInstanceOf(UnroutableError);

        // The reply slot must be released when the request never landed,
        // rather than lingering until its RPC deadline expires.
        expect((dispatcher as any).callbacks.size).toBe(0);
    });
});
