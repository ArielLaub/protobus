import Connection, { MessageHandler, ConsumeRetryOptions, MessageHandlerContext } from '../../lib/connection';

class FakeChannel {
    public acked: any[] = [];
    public published: Array<{ exchange: string; options: any }> = [];
    public sentToQueue: Array<{ queue: string; options: any }> = [];
    private onMessage: ((msg: any) => Promise<void>) | undefined;
    async prefetch() { return undefined; }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack(msg: any) { this.acked.push(msg); }
    reject() { /* not used here */ }
    publish(exchange: string, _rk: string, _c: Buffer, options: any, cb?: any) {
        this.published.push({ exchange, options });
        if (cb) setImmediate(() => cb(null));
        return true;
    }
    sendToQueue(queue: string, _c: Buffer, options: any, cb?: any) {
        this.sentToQueue.push({ queue, options });
        if (cb) setImmediate(() => cb(null));
        return true;
    }
    once() { return this; }
    async deliver(msg: any) { if (this.onMessage) await this.onMessage(msg); }
}

const RETRY: ConsumeRetryOptions = {
    maxRetries: 2,
    retryQueueName: 'Svc.Retry',
    retryExchangeName: 'Svc.Retry.Exchange',
    dlqName: 'Svc.DLQ',
};

function message(overrides: any = {}) {
    return {
        content: Buffer.from('payload'),
        fields: { routingKey: 'REQUEST.Svc.Api.doThing', redelivered: false, ...(overrides.fields || {}) },
        properties: {
            correlationId: 'cid-1',
            messageId: 'stable-id-1',
            replyTo: 'callback.queue',
            headers: {},
            ...(overrides.properties || {}),
        },
    };
}

describe('message identity survives the paths that duplicate', () => {
    it('carries messageId onto the retry publish', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        await conn.consume(ch as any, 'Svc', async () => { throw new Error('boom'); },
            { noAck: false } as any, true, RETRY);
        await ch.deliver(message());

        const retry = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange');
        expect(retry).toBeDefined();
        expect(retry!.options.messageId).toBe('stable-id-1');
    });

    it('carries messageId onto the DLQ publish', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        await conn.consume(ch as any, 'Svc', async () => { throw new Error('boom'); },
            { noAck: false } as any, true, RETRY);
        await ch.deliver(message({ properties: { headers: { 'x-retry-count': 2 } } }));

        const dlq = ch.sentToQueue.find(s => s.queue === 'Svc.DLQ');
        expect(dlq).toBeDefined();
        expect(dlq!.options.messageId).toBe('stable-id-1');
    });

    it('gives the handler the identity it needs to deduplicate', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        let seen: MessageHandlerContext | undefined;
        const handler: MessageHandler = async (_c, _id, _h, context) => { seen = context; return undefined; };

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await ch.deliver(message({ fields: { redelivered: true } }));

        expect(seen!.messageId).toBe('stable-id-1');
        expect(seen!.redelivered).toBe(true);
    });
});
