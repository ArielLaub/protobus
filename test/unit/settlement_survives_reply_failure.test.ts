import Connection, { MessageHandler, ConsumeRetryOptions } from '../../lib/connection';
import Config from '../../lib/config';

/**
 * A failed error-REPLY must never prevent the message being SETTLED.
 *
 * On the terminal paths the connection layer answers the caller first and
 * settles second — reply, then DLQ, then ack; or reply, then reject. Both
 * awaits are on the same `await` chain, so a reply publish that rejects takes
 * the whole arm with it. The message is then neither dead-lettered nor
 * rejected: it stays unacknowledged, holding a prefetch slot, and comes back
 * on the next channel to fail in exactly the same place, having consumed its
 * whole retry budget already. It can never reach the DLQ, which is the one
 * place an operator would look for it.
 *
 * The reply is the part that is allowed to fail here. The caller has a
 * timeout; the DLQ is the only durable record.
 */

class FakeChannel {
    public acked: any[] = [];
    public rejected: any[] = [];
    public published: Array<{ exchange: string; routingKey: string }> = [];
    public sentToQueue: Array<{ queue: string }> = [];
    public failPublishTo = new Set<string>();
    private onMessage: ((msg: any) => Promise<void>) | undefined;

    async prefetch() { /* not under test */ }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack(msg: any) { this.acked.push(msg); }
    reject(msg: any) { this.rejected.push(msg); }
    publish(exchange: string, routingKey: string, _c: Buffer, _o: any, cb?: any) {
        if (this.failPublishTo.has(exchange)) {
            if (cb) { setImmediate(() => cb(new Error('broker refused the reply'))); }
            return true;
        }
        this.published.push({ exchange, routingKey });
        if (cb) { setImmediate(() => cb(null)); }
        return true;
    }
    sendToQueue(queue: string, _c: Buffer, _o: any, cb?: any) {
        this.sentToQueue.push({ queue });
        if (cb) { setImmediate(() => cb(null)); }
        return true;
    }
    once() { return this; }
    async deliver(msg: any) { if (this.onMessage) { await this.onMessage(msg); } }
}

const RETRY: ConsumeRetryOptions = {
    maxRetries: 2,
    retryQueueName: 'Svc.Retry',
    retryExchangeName: 'Svc.Retry.Exchange',
    dlqName: 'Svc.DLQ',
};

/**
 * A handler failing the way MessageService makes it fail: the encoded error
 * response rides on the thrown error under a well-known property, which is
 * what the connection layer publishes back to the caller.
 */
const handlerWithPreEncodedReply: MessageHandler = async () => {
    const err: any = new Error('permanent failure');
    err.__PROTOBUS_RESPONSE_BUFFER = Buffer.from('encoded-error-response');
    throw err;
};

function message(retryCount: number) {
    return {
        content: Buffer.from('payload'),
        fields: { routingKey: 'REQUEST.Svc.Api.doThing' },
        properties: {
            contentType: 'application/octet-stream',
            correlationId: 'cid-1',
            messageId: 'mid-1',
            replyTo: 'amq.gen-callback',
            headers: retryCount ? { 'x-retry-count': retryCount } : {},
        },
    };
}

async function deliverWithBrokenReply(retry: ConsumeRetryOptions | undefined, retryCount: number) {
    const conn = new Connection();
    const ch = new FakeChannel();
    ch.failPublishTo.add(Config.callbacksExchangeName);
    await conn.consume(
        ch as any, 'Svc', handlerWithPreEncodedReply, { noAck: false } as any, true, retry,
    );
    await ch.deliver(message(retryCount));
    return ch;
}

describe('terminal settlement when the error reply cannot be published', () => {
    it('still dead-letters the message once retries are exhausted', async () => {
        const ch = await deliverWithBrokenReply(RETRY, RETRY.maxRetries);
        expect(ch.sentToQueue.map(s => s.queue)).toContain('Svc.DLQ');
    });

    it('still acks it, so it does not hold a prefetch slot for ever', async () => {
        const ch = await deliverWithBrokenReply(RETRY, RETRY.maxRetries);
        expect(ch.acked).toHaveLength(1);
    });

    it('still rejects it when no retry is configured', async () => {
        const ch = await deliverWithBrokenReply(undefined, 0);
        expect(ch.rejected).toHaveLength(1);
    });

    it('a working reply is still published on the DLQ path', async () => {
        // The guard must not turn the reply off — only stop it blocking.
        const conn = new Connection();
        const ch = new FakeChannel();
        await conn.consume(
            ch as any, 'Svc', handlerWithPreEncodedReply, { noAck: false } as any, true, RETRY,
        );
        await ch.deliver(message(RETRY.maxRetries));
        expect(ch.published.map(p => p.exchange)).toContain(Config.callbacksExchangeName);
        expect(ch.sentToQueue.map(s => s.queue)).toContain('Svc.DLQ');
        expect(ch.acked).toHaveLength(1);
    });
});
