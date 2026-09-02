import Connection, { MessageHandler, ConsumeRetryOptions } from '../../lib/connection';

/**
 * Protobus does not let the broker move a failed message. It RE-PUBLISHES it,
 * building a fresh AMQP properties object by hand at each hop — so every
 * property that matters has to be copied explicitly, and any that is not is
 * silently dropped.
 *
 * 2.2.0 fixed `priority` this way. `contentType` was lost in exactly the same
 * place and for exactly the same reason, which says the republish sites were
 * never audited as a *set*. So this suite asserts the whole set: every
 * property present on the original either survives the hop, or appears in
 * DELIBERATELY_DROPPED with a reason. A property added later to the publish
 * path fails here until someone decides which it is.
 */

class FakeChannel {
    public acked: any[] = [];
    public rejected: any[] = [];
    public published: Array<{ exchange: string; routingKey: string; options: any }> = [];
    public sentToQueue: Array<{ queue: string; options: any }> = [];
    public writable = true;
    /** Exchanges whose publishes should fail, to model a broken reply path. */
    public failPublishTo = new Set<string>();
    private onMessage: ((msg: any) => Promise<void>) | undefined;

    async prefetch() { /* not under test */ }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack(msg: any) { this.acked.push(msg); }
    reject(msg: any) { this.rejected.push(msg); }
    publish(exchange: string, routingKey: string, _c: Buffer, options: any, cb?: any) {
        if (this.failPublishTo.has(exchange)) {
            if (cb) { setImmediate(() => cb(new Error('NACK: broker refused the reply'))); }
            return this.writable;
        }
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

/** Every AMQP property the library or a caller can put on a request. */
const ORIGINAL_PROPERTIES: Record<string, any> = {
    contentType: 'application/octet-stream',
    contentEncoding: 'gzip',
    correlationId: 'cid-1',
    messageId: 'mid-1',
    replyTo: 'amq.gen-callback',
    deliveryMode: 2,
    priority: 7,
    timestamp: 1700000000,
    type: 'Svc.Api.Request',
    appId: 'orders-api',
    userId: 'guest',
    expiration: '60000',
    headers: { 'x-tenant': 'acme' },
};

/**
 * Properties a republish must NOT copy, each for a reason that is about the
 * hop rather than about the property.
 */
const DELIBERATELY_DROPPED: Record<string, string> = {
    deliveryMode:
        're-expressed as `persistent: true`, which amqplib maps back to deliveryMode 2',
    expiration:
        'a per-message TTL. On the retry queue it would race that queue own x-message-ttl '
        + 'and fire an early redelivery; on the DLQ it would quietly delete the evidence an '
        + 'operator is meant to find.',
    userId:
        'RabbitMQ validates user-id against the publishing connection user and closes the '
        + 'channel on a mismatch. The republish is made by the CONSUMER connection, which '
        + 'need not be the original publisher.',
};

/** Dropped on the DLQ hop only. */
const DROPPED_ON_DLQ: Record<string, string> = {
    replyTo:
        'the caller has already been answered on the error-reply path, and its callback '
        + 'queue is exclusive and auto-delete, so it is gone by the time anyone replays the DLQ',
};

function message(retryCount = 0) {
    return {
        content: Buffer.from('payload'),
        fields: { routingKey: 'REQUEST.Svc.Api.doThing' },
        properties: {
            ...ORIGINAL_PROPERTIES,
            headers: retryCount
                ? { ...ORIGINAL_PROPERTIES.headers, 'x-retry-count': retryCount }
                : { ...ORIGINAL_PROPERTIES.headers },
        },
    };
}

const RETRY: ConsumeRetryOptions = {
    maxRetries: 2,
    retryQueueName: 'Svc.Retry',
    retryExchangeName: 'Svc.Retry.Exchange',
    dlqName: 'Svc.DLQ',
};

const throwingHandler: MessageHandler = async () => { throw new Error('boom'); };

async function deliverOnce(ch: FakeChannel, retryCount = 0, retry: ConsumeRetryOptions = RETRY) {
    const conn = new Connection();
    await conn.consume(ch as any, 'Svc', throwingHandler, { noAck: false } as any, true, retry);
    await ch.deliver(message(retryCount));
}

describe('a re-published message keeps its content type', () => {
    it('carries contentType onto the retry exchange', async () => {
        const ch = new FakeChannel();
        await deliverOnce(ch);
        const hop = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange');
        expect(hop).toBeDefined();
        expect(hop!.options.contentType).toBe('application/octet-stream');
    });

    it('carries contentType onto the retry queue on the no-exchange fallback', async () => {
        const ch = new FakeChannel();
        await deliverOnce(ch, 0, { ...RETRY, retryExchangeName: undefined });
        const hop = ch.sentToQueue.find(p => p.queue === 'Svc.Retry');
        expect(hop).toBeDefined();
        expect(hop!.options.contentType).toBe('application/octet-stream');
    });

    it('carries contentType onto the DLQ once retries are exhausted', async () => {
        const ch = new FakeChannel();
        await deliverOnce(ch, RETRY.maxRetries);
        const hop = ch.sentToQueue.find(p => p.queue === 'Svc.DLQ');
        expect(hop).toBeDefined();
        expect(hop!.options.contentType).toBe('application/octet-stream');
    });
});

describe('the republish property set is audited as a whole', () => {
    it('the retry hop carries every property that is not deliberately dropped', async () => {
        const ch = new FakeChannel();
        await deliverOnce(ch);
        const hop = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange')!;

        const missing = Object.keys(ORIGINAL_PROPERTIES)
            .filter(k => k !== 'headers')
            .filter(k => !(k in DELIBERATELY_DROPPED))
            .filter(k => hop.options[k] !== ORIGINAL_PROPERTIES[k]);
        expect(missing).toEqual([]);
    });

    it('the DLQ hop carries every property that is not deliberately dropped', async () => {
        const ch = new FakeChannel();
        await deliverOnce(ch, RETRY.maxRetries);
        const hop = ch.sentToQueue.find(p => p.queue === 'Svc.DLQ')!;

        const missing = Object.keys(ORIGINAL_PROPERTIES)
            .filter(k => k !== 'headers')
            .filter(k => !(k in DELIBERATELY_DROPPED))
            .filter(k => !(k in DROPPED_ON_DLQ))
            .filter(k => hop.options[k] !== ORIGINAL_PROPERTIES[k]);
        expect(missing).toEqual([]);
    });

    it('drops exactly the properties it means to, and no others', async () => {
        const ch = new FakeChannel();
        await deliverOnce(ch);
        const hop = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange')!;

        for (const key of Object.keys(DELIBERATELY_DROPPED)) {
            expect({ key, present: key in hop.options }).toEqual({ key, present: false });
        }
        // Persistence is preserved, just spelled the other way.
        expect(hop.options.persistent).toBe(true);
    });

    it('gains no property the original did not carry', async () => {
        const ch = new FakeChannel();
        const bare = {
            content: Buffer.from('payload'),
            fields: { routingKey: 'REQUEST.Svc.Api.doThing' },
            properties: { correlationId: 'cid-1', headers: {} },
        };
        const conn = new Connection();
        await conn.consume(ch as any, 'Svc', throwingHandler, { noAck: false } as any, true, RETRY);
        await ch.deliver(bare);

        const hop = ch.published.find(p => p.exchange === 'Svc.Retry.Exchange')!;
        for (const key of ['contentType', 'contentEncoding', 'priority', 'timestamp', 'type', 'appId']) {
            expect({ key, present: key in hop.options }).toEqual({ key, present: false });
        }
    });
});
