import { EventEmitter } from 'events';

import MessageDispatcher from '../../lib/message_dispatcher';
import CancelListener from '../../lib/cancel_listener';
import Config from '../../lib/config';
import { ILogger, set as setLogger, DefaultLogger } from '../../lib/logger';

/**
 * Compatibility guarantees for stream cancellation. Cancellation is additive:
 * an existing deployment that knows nothing about it must behave exactly as it
 * did, including one whose broker credentials cannot declare the new exchange.
 */

class BaseStubConnection extends EventEmitter {
    public isConnected = true;
    public isReconnecting = false;
    public published: Array<{ exchange: string; routingKey: string; options: any }> = [];

    async openChannel(): Promise<any> {
        return {
            prefetch: async () => undefined,
            consume: async () => ({ consumerTag: 'tag' }),
            close: async () => undefined,
        };
    }
    async closeChannel() { return undefined; }
    async declareExchange() { return undefined; }
    async declareQueue(_ch: any, name: string) { return name || 'amq.gen-stub'; }
    async bindQueue() { return undefined; }
    async unbindQueue() { return undefined; }
    async deleteQueue() { return undefined; }
    async ack() { return undefined; }
    async reject() { return undefined; }
    async consume() { return { consumerTag: 'tag' }; }
    async cancel() { return undefined; }
    async purgeQueue() { return undefined; }
    async publish(_ch: any, exchange: string, routingKey: string, _c: Buffer, options: any) {
        this.published.push({ exchange, routingKey, options });
    }
    async publishToQueue() { return undefined; }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }
}

class CapturingLogger implements ILogger {
    public lines: string[] = [];
    info(m: any) { this.lines.push(String(m)); }
    warn(m: any) { this.lines.push(String(m)); }
    debug(m: any) { this.lines.push(String(m)); }
    error(m: any) { this.lines.push(String(m)); }
    get text() { return this.lines.join('\n'); }
}

describe('cancellation is additive', () => {
    afterEach(() => setLogger(new DefaultLogger()));

    it('works against a connection that does not implement cancelStream', async () => {
        // A custom IConnection written before cancellation existed. The
        // interface member is optional precisely so this still type-checks and
        // still runs.
        const conn = new BaseStubConnection();
        expect((conn as any).cancelStream).toBeUndefined();

        const listener = new CancelListener(conn as any);
        await listener.start();

        // Delivering a cancel must not throw when the hook is absent.
        expect(() => (conn as any).emit('reconnected')).not.toThrow();
        await listener.close();
    });

    it('keeps the service usable when the cancel exchange cannot be declared', async () => {
        const log = new CapturingLogger();
        setLogger(log);

        class NoPermissionConnection extends BaseStubConnection {
            async declareExchange() { throw new Error('ACCESS_REFUSED - configure access to exchange'); }
        }

        const listener = new CancelListener(new NoPermissionConnection() as any);

        // Restricted broker permissions must degrade cancellation, not startup.
        await expect(listener.start()).resolves.toBeUndefined();
        expect(log.text).toContain('cancellation unavailable');
    });

    it('publishes a cancel to the fanout exchange when a stream is abandoned', async () => {
        const conn = new BaseStubConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const iterator = d.publishStreaming(Buffer.from('req'), 'REQUEST.A.B.c', 5000)[Symbol.asyncIterator]();
        await iterator.return!();

        const cancels = conn.published.filter(p => p.exchange === Config.cancelExchangeName);
        expect(cancels).toHaveLength(1);
        // Fanout ignores the routing key; the correlationId is what identifies
        // the stream to whichever replica owns it.
        expect(cancels[0].routingKey).toBe('');
        expect(typeof cancels[0].options.correlationId).toBe('string');
    });

    it('cancels immediately when an AbortSignal fires', async () => {
        const conn = new BaseStubConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const controller = new AbortController();
        d.publishStreaming(Buffer.from('req'), 'REQUEST.A.B.c', 5000, { signal: controller.signal });

        expect(conn.published.filter(p => p.exchange === Config.cancelExchangeName)).toHaveLength(0);

        // Aborted from outside the loop, which is where a Stop button lives.
        controller.abort();
        await new Promise((r) => setImmediate(r));

        expect(conn.published.filter(p => p.exchange === Config.cancelExchangeName)).toHaveLength(1);
    });

    it('sends exactly one cancel however many times it is triggered', async () => {
        const conn = new BaseStubConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const controller = new AbortController();
        const iterator = d.publishStreaming(
            Buffer.from('req'), 'REQUEST.A.B.c', 5000, { signal: controller.signal },
        )[Symbol.asyncIterator]();

        controller.abort();
        await iterator.return!();
        await new Promise((r) => setImmediate(r));

        // Delivery is at-most-once by design; it is never re-sent for us.
        expect(conn.published.filter(p => p.exchange === Config.cancelExchangeName)).toHaveLength(1);
    });
});
