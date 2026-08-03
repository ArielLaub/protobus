import { EventEmitter } from 'events';
import Connection, { MessageHandler, ConsumeRetryOptions } from '../../lib/connection';
import MessageService from '../../lib/message_service';
import MessageFactory from '../../lib/message_factory';
import { HandledError } from '../../lib/errors';

/**
 * A fake amqplib Channel that records everything the connection layer does to
 * it. The retry/ack/DLQ state machine in connection.ts had no unit coverage at
 * all — it was only reachable through Docker-gated integration tests — which is
 * why the defects below survived.
 */
class FakeChannel {
    public acked: any[] = [];
    public rejected: Array<{ msg: any; requeue: boolean }> = [];
    public published: Array<{ exchange: string; routingKey: string; content: Buffer; options: any }> = [];
    public sentToQueue: Array<{ queue: string; options: any }> = [];
    /** When false, publish() reports a full write buffer, as amqplib does. */
    public writable = true;
    public drainListeners: Array<() => void> = [];
    private onMessage: ((msg: any) => Promise<void>) | undefined;

    async prefetch() { return undefined; }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack(msg: any) { this.acked.push(msg); }
    reject(msg: any, requeue: boolean) { this.rejected.push({ msg, requeue }); }
    publish(exchange: string, routingKey: string, content: Buffer, options: any) {
        this.published.push({ exchange, routingKey, content, options });
        return this.writable;
    }
    async sendToQueue(queue: string, _content: Buffer, options: any) {
        this.sentToQueue.push({ queue, options });
        return true;
    }
    once(event: string, cb: () => void) {
        if (event === 'drain') { this.drainListeners.push(cb); }
        return this;
    }
    emitDrain() { const l = this.drainListeners; this.drainListeners = []; l.forEach(cb => cb()); }

    async deliver(msg: any) { if (this.onMessage) { await this.onMessage(msg); } }
}

function message(overrides: any = {}) {
    return {
        content: Buffer.from('payload'),
        fields: { routingKey: 'REQUEST.Svc.Api.doThing', ...(overrides.fields || {}) },
        properties: {
            correlationId: 'cid-1',
            replyTo: 'callback.queue',
            headers: {},
            ...(overrides.properties || {}),
        },
    };
}

const RETRY: ConsumeRetryOptions = {
    maxRetries: 2,
    retryQueueName: 'Svc.Retry',
    retryExchangeName: 'Svc.Retry.Exchange',
    dlqName: 'Svc.DLQ',
};

describe('handler errors on the default (late-ack) path', () => {
    it('retries an unhandled error rather than dropping the message', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const handler: MessageHandler = async () => { throw new Error('boom'); };

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await ch.deliver(message());

        expect(ch.published.map(p => p.exchange)).toContain('Svc.Retry.Exchange');
        expect(ch.acked.length).toBe(1);
    });

    it('publishes the pre-encoded error reply to the caller once retries are exhausted', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const errorReply = Buffer.from('encoded-error');
        const handler: MessageHandler = async () => {
            const err: any = new Error('still broken');
            err.__PROTOBUS_RESPONSE_BUFFER = errorReply;
            throw err;
        };

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await ch.deliver(message({ properties: { headers: { 'x-retry-count': 2 } } }));

        expect(ch.published.some(p => p.content === errorReply)).toBe(true);
        expect(ch.sentToQueue.map(s => s.queue)).toContain('Svc.DLQ');
    });

    it('does not retry a HandledError, and replies to the caller', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const errorReply = Buffer.from('validation-failed');
        const handler: MessageHandler = async () => {
            const err: any = new HandledError('bad input', 'VALIDATION');
            err.__PROTOBUS_RESPONSE_BUFFER = errorReply;
            throw err;
        };

        await conn.consume(
            ch as any, 'Svc', handler, { noAck: false } as any, true,
            { ...RETRY, isHandledError: (e: any) => e?.isHandled === true },
        );
        await ch.deliver(message());

        expect(ch.published.some(p => p.content === errorReply)).toBe(true);
        expect(ch.published.some(p => p.exchange === 'Svc.Retry.Exchange')).toBe(false);
        expect(ch.rejected.length).toBe(1);
    });
});

describe('handler errors when the caller acks early', () => {
    it('still replies to the caller instead of leaving it to time out', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const errorReply = Buffer.from('encoded-error');
        const handler: MessageHandler = async () => {
            const err: any = new Error('boom');
            err.__PROTOBUS_RESPONSE_BUFFER = errorReply;
            throw err;
        };

        // lateAck = false: the message is acked before processing, so retry and
        // DLQ are impossible — but the caller must still learn it failed.
        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, false, RETRY);
        await ch.deliver(message());

        expect(ch.published.some(p => p.content === errorReply)).toBe(true);
    });
});

describe('message processing timeout', () => {
    it('rejects a handler that overruns the timeout', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const errorReply = Buffer.from('timeout-error');
        let handlerSawAbort = false;

        const handler: MessageHandler = async (_c, _id, _h, opts?: any) => {
            opts?.signal?.addEventListener('abort', () => { handlerSawAbort = true; });
            await new Promise((r) => setTimeout(r, 200));
            return errorReply;
        };

        await conn.consume(
            ch as any, 'Svc', handler, { noAck: false } as any, true,
            { ...RETRY, maxRetries: 0 },
            30, // 30ms processing timeout
        );
        await ch.deliver(message());

        // The successful-but-late buffer must NOT be published as a reply.
        expect(ch.published.some(p => p.content === errorReply)).toBe(false);
        expect(handlerSawAbort).toBe(true);
    });

    it('does not penalise a handler that finishes within the timeout', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const reply = Buffer.from('ok');
        const handler: MessageHandler = async () => reply;

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, undefined, 5000);
        await ch.deliver(message());

        expect(ch.published.some(p => p.content === reply)).toBe(true);
        expect(ch.acked.length).toBe(1);
    });
});

describe('publisher backpressure', () => {
    it('waits for drain when the channel write buffer is full', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        ch.writable = false;

        let settled = false;
        const p = conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {}).then(() => { settled = true; });

        await new Promise((r) => setImmediate(r));
        expect(settled).toBe(false);       // still parked on 'drain'
        expect(ch.drainListeners.length).toBe(1);

        ch.emitDrain();
        await p;
        expect(settled).toBe(true);
    });

    it('resolves immediately when the channel accepts the write', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        await conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {});
        expect(ch.published.length).toBe(1);
    });
});

describe('null delivery on server-side consumer cancellation', () => {
    it('does not crash when amqplib delivers null', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();
        const handler: MessageHandler = async () => undefined;

        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, RETRY);
        await expect(ch.deliver(null)).resolves.not.toThrow();
    });
});

describe('dispatch honours the broker routing key', () => {
    const PROTO = `
        syntax = "proto3";
        package Bank;
        message Req { string x = 1; }
        message Res { string y = 1; }
        service Api {
          rpc read (Req) returns (Res);
          rpc deleteAll (Req) returns (Res);
        }
    `;

    function service() {
        const f = new MessageFactory();
        f.init([]);
        f.parse(PROTO);
        const ctx: any = { factory: f, connection: new EventEmitter(), publishEvent: async () => undefined };
        const calls: string[] = [];
        class Svc extends MessageService {
            get ServiceName() { return 'Bank.Api'; }
            get ProtoFileName() { return 'Bank.proto'; }
            async read() { calls.push('read'); return { y: 'read' }; }
            async deleteAll() { calls.push('deleteAll'); return { y: 'deleted' }; }
        }
        return { svc: new Svc(ctx), f, calls };
    }

    it('runs the method the routing key names', async () => {
        const { svc, f, calls } = service();
        const buf = f.buildRequest('Bank.Api.read', { x: 'a' }, 'alice');
        await (svc as any)._onMessage(buf, 'cid', {}, 'REQUEST.Bank.Api.read');
        expect(calls).toEqual(['read']);
    });

    it('refuses a body method that contradicts the routing key', async () => {
        const { svc, f, calls } = service();
        // Broker routed this as `read`; the body claims `deleteAll`.
        const buf = f.buildRequest('Bank.Api.deleteAll', { x: 'a' }, 'attacker');
        const out = await (svc as any)._onMessage(buf, 'cid', {}, 'REQUEST.Bank.Api.read');

        expect(calls).toEqual([]);
        const decoded = f.decodeResponse(out);
        expect(decoded.error).toBeTruthy();
    });

    it('refuses a method belonging to a different service', async () => {
        const { svc, f, calls } = service();
        const buf = f.buildRequest('Bank.Api.deleteAll', { x: 'a' }, 'attacker');
        const out = await (svc as any)._onMessage(buf, 'cid', {}, 'REQUEST.Other.Api.deleteAll');
        expect(calls).toEqual([]);
        expect(f.decodeResponse(out).error).toBeTruthy();
    });

    it('still works when no routing key is supplied (backward compatible)', async () => {
        const { svc, f, calls } = service();
        const buf = f.buildRequest('Bank.Api.read', { x: 'a' }, 'alice');
        await (svc as any)._onMessage(buf, 'cid', {});
        expect(calls).toEqual(['read']);
    });
});
