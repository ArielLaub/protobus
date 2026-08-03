import { EventEmitter } from 'events';
import MessageDispatcher from '../../lib/message_dispatcher';
import EventListener from '../../lib/event_listener';
import MessageListener from '../../lib/message_listener';
import MessageFactory from '../../lib/message_factory';
import { RpcTimeoutError } from '../../lib/errors';

/**
 * A connection stub that accepts publishes and never replies. This is the
 * shape of every real failure that used to hang a caller forever: no consumer
 * bound to the routing key, an exchange that dropped the message, or a handler
 * that died after an early ack.
 */
class SilentConnection extends EventEmitter {
    public isConnected = true;
    public isReconnecting = false;
    public prefetchCalls: Array<number | undefined> = [];
    public published: Array<{ exchange: string; routingKey: string }> = [];

    async openChannel(): Promise<any> {
        return {
            prefetch: async (count?: number) => { this.prefetchCalls.push(count); },
            consume: async () => ({ consumerTag: 'tag' }),
            close: async () => undefined,
            publish: () => true,
        };
    }
    async closeChannel() { return undefined; }
    async declareExchange() { return undefined; }
    async declareQueue(_ch: any, name: string) { return name || 'anonymous.queue'; }
    async bindQueue() { return undefined; }
    async unbindQueue() { return undefined; }
    async deleteQueue() { return undefined; }
    async ack() { return undefined; }
    async reject() { return undefined; }
    async consume() { return { consumerTag: 'tag' }; }
    async cancel() { return undefined; }
    async purgeQueue() { return undefined; }
    async publish(_ch: any, exchange: string, routingKey: string) {
        this.published.push({ exchange, routingKey });
    }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }
}

describe('unary RPC call timeout', () => {
    it('rejects with RpcTimeoutError instead of hanging forever', async () => {
        const conn = new SilentConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        await expect(
            d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 40),
        ).rejects.toBeInstanceOf(RpcTimeoutError);
    });

    it('does not leak the pending callback entry after a timeout', async () => {
        const conn = new SilentConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        await expect(d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 40)).rejects.toThrow();
        expect((d as any).callbacks.size).toBe(0);
    });

    it('still resolves normally when a reply arrives before the timeout', async () => {
        const conn = new SilentConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const pending = d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 5000);
        // publish() awaits the underlying publish before registering the
        // callback, so yield until the correlationId is actually in the map.
        while ((d as any).callbacks.size === 0) {
            await new Promise((r) => setImmediate(r));
        }
        const id = Array.from((d as any).callbacks.keys())[0] as string;
        await (d as any)._onResult(Buffer.from('reply'), id, {});

        await expect(pending).resolves.toEqual(Buffer.from('reply'));
        expect((d as any).callbacks.size).toBe(0);
    });

    it('does not arm a timeout for fire-and-forget publishes', async () => {
        const conn = new SilentConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        await expect(d.publish(Buffer.from('x'), 'EVENT.x', false, 10)).resolves.toBeUndefined();
        expect((d as any).callbacks.size).toBe(0);
    });
});

describe('late-ack consumers bound their prefetch', () => {
    it('EventListener does not request unlimited prefetch', async () => {
        const conn = new SilentConnection();
        const listener = new EventListener(conn as any, new MessageFactory());
        await listener.init(undefined as any, 'Svc.Events');

        expect(conn.prefetchCalls.length).toBeGreaterThan(0);
        for (const c of conn.prefetchCalls) {
            // amqplib maps undefined/0 to prefetchCount 0, which means unlimited:
            // with late ack that lets the broker push a whole backlog into memory.
            expect(typeof c).toBe('number');
            expect(c).toBeGreaterThan(0);
        }
    });

    it('MessageListener keeps its explicit prefetch', async () => {
        const conn = new SilentConnection();
        const listener = new MessageListener(conn as any, true, 7);
        await listener.init(undefined as any, 'Svc');
        expect(conn.prefetchCalls).toContain(7);
    });
});
