import { EventEmitter } from 'events';

import Connection, { MessageHandler, ConsumeRetryOptions } from '../../lib/connection';
import MessageService from '../../lib/message_service';
import MessageListener from '../../lib/message_listener';
import MessageFactory from '../../lib/message_factory';
import { InvalidPriorityError } from '../../lib/priority';
import Config from '../../lib/config';

/**
 * Fake channel recording what the connection layer republishes, so the retry
 * and DLQ hops can be inspected without a broker.
 */
class FakeChannel {
    public acked: any[] = [];
    public rejected: any[] = [];
    public published: Array<{ exchange: string; routingKey: string; options: any }> = [];
    public sentToQueue: Array<{ queue: string; options: any }> = [];
    public prefetchCalls: Array<number | undefined> = [];
    public writable = true;
    private onMessage: ((msg: any) => Promise<void>) | undefined;

    async prefetch(count?: number) { this.prefetchCalls.push(count); }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack(msg: any) { this.acked.push(msg); }
    reject(msg: any) { this.rejected.push(msg); }
    publish(exchange: string, routingKey: string, _c: Buffer, options: any, cb?: any) {
        this.published.push({ exchange, routingKey, options });
        if (cb) { setImmediate(() => cb(null)); }
        return this.writable;
    }
    sendToQueue(queue: string, _c: Buffer, options: any, cb?: any) {
        this.sentToQueue.push({ queue, options });
        if (cb) { setImmediate(() => cb(null)); }
        return this.writable;
    }
    once() { return this; }
    async deliver(msg: any) { if (this.onMessage) { await this.onMessage(msg); } }
}

function message(priority: number | undefined, retryCount = 0) {
    return {
        content: Buffer.from('payload'),
        fields: { routingKey: 'REQUEST.Svc.Api.doThing' },
        properties: {
            correlationId: 'cid-1',
            messageId: 'mid-1',
            replyTo: undefined,
            priority,
            headers: retryCount ? { 'x-retry-count': retryCount } : {},
        },
    };
}

const RETRY: ConsumeRetryOptions = {
    maxRetries: 2,
    retryQueueName: 'Svc.Retry',
    retryExchangeName: 'Svc.Retry.Exchange',
    dlqName: 'Svc.DLQ',
};

/**
 * Protobus does not let the broker move a failed message — it RE-PUBLISHES it
 * onto the retry exchange, building a fresh properties object by hand. Any
 * property not copied there is silently dropped, and `priority` is the one that
 * matters here: a control message that fails once would come back at priority 0
 * and queue behind the entire bulk backlog, which is the exact failure this
 * feature exists to prevent. It only shows up after something else has already
 * gone wrong, so nothing would have caught it in normal operation.
 */
describe('a re-published message keeps its priority', () => {
    it('carries the priority onto the retry exchange', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const handler: MessageHandler = async () => { throw new Error('boom'); };

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await ch.deliver(message(Config.PRIORITY_CONTROL));

        const retryHop = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange');
        expect(retryHop).toBeDefined();
        expect(retryHop!.options.priority).toBe(Config.PRIORITY_CONTROL);
    });

    it('carries the priority onto the retry queue on the no-exchange fallback', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const handler: MessageHandler = async () => { throw new Error('boom'); };

        const noExchange = { ...RETRY, retryExchangeName: undefined };
        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, noExchange);
        await ch.deliver(message(Config.PRIORITY_CONTROL));

        const hop = ch.sentToQueue.find(p => p.queue === 'Svc.Retry');
        expect(hop).toBeDefined();
        expect(hop!.options.priority).toBe(Config.PRIORITY_CONTROL);
    });

    it('carries the priority onto the DLQ once retries are exhausted', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const handler: MessageHandler = async () => { throw new Error('boom'); };

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await ch.deliver(message(Config.PRIORITY_CONTROL, RETRY.maxRetries));

        const dlq = ch.sentToQueue.find(p => p.queue === 'Svc.DLQ');
        expect(dlq).toBeDefined();
        expect(dlq!.options.priority).toBe(Config.PRIORITY_CONTROL);
    });

    it('sets no priority on the retry hop when the original had none', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const handler: MessageHandler = async () => { throw new Error('boom'); };

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await ch.deliver(message(undefined));

        const retryHop = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange');
        expect(Object.prototype.hasOwnProperty.call(retryHop!.options, 'priority')).toBe(false);
    });
});

/**
 * Priority only reorders what is still IN the queue. An auto-ack consumer has
 * no QoS prefetch at all — RabbitMQ ignores prefetch for auto-ack — so the
 * broker pushes the whole queue into the consumer and nothing is left to
 * reorder. The queue is correctly declared, the operator has already done the
 * drain-and-recreate migration, and the feature does nothing, with no error
 * anywhere. Refused at construction rather than warned about.
 */
describe('maxPriority requires a bounded prefetch to do anything', () => {
    class Svc extends MessageService {
        public get ServiceName() { return 'Test.Svc'; }
        public get ProtoFileName() { return 'unused.proto'; }
    }
    function context(): any {
        return { connection: new EventEmitter() as any, factory: new MessageFactory() };
    }

    it('rejects maxPriority combined with lateAck: false', () => {
        expect(() => new Svc(context(), { maxPriority: 2, lateAck: false }))
            .toThrow(InvalidPriorityError);
    });

    it('allows maxPriority on the default (late-ack) path', () => {
        expect(() => new Svc(context(), { maxPriority: 2 })).not.toThrow();
    });

    it('still allows lateAck: false when no priority is asked for', () => {
        expect(() => new Svc(context(), { lateAck: false })).not.toThrow();
    });

    it('applies a bounded prefetch on the late-ack path, which is what priority relies on', async () => {
        const ch = new FakeChannel();
        const conn = Object.assign(new EventEmitter(), {
            isConnected: true, isReconnecting: false,
            openChannel: async () => ch,
            closeChannel: async () => undefined,
            declareExchange: async () => undefined,
            declareQueue: async (_c: any, n: string) => n || 'q',
            bindQueue: async () => undefined,
            consume: async () => ({ consumerTag: 't' }),
        }) as any;

        const listener = new MessageListener(conn, true, undefined, { maxRetries: 0, retryDelayMs: 1 }, undefined, 2);
        await listener.init(async () => undefined, 'Svc');

        expect(ch.prefetchCalls).toHaveLength(1);
        expect(ch.prefetchCalls[0]).toBeGreaterThan(0);
    });
});
