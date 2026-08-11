import { EventEmitter } from 'events';

import Connection from '../../lib/connection';
import MessageDispatcher from '../../lib/message_dispatcher';
import { StreamBackpressureError, StreamTimeoutError } from '../../lib/errors';

/**
 * Regression coverage for the delivery-ordering and stream-bounding findings in
 * the 2026-08-11 audit. Each test here was first written to fail against the
 * implementation as it stood, so it pins the contract rather than the code.
 */

/** Records ack/publish interleaving, which separate arrays cannot express. */
class OrderingChannel {
    public events: string[] = [];
    private onMessage: ((msg: any) => Promise<void>) | undefined;

    async prefetch() { return undefined; }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack() { this.events.push('ack'); }
    reject() { this.events.push('reject'); }
    publish(_exchange: string, routingKey: string, _content: Buffer, _options: any, callback?: any) {
        this.events.push(`publish:${routingKey}`);
        // Confirm asynchronously, as a real ConfirmChannel does.
        if (callback) { setImmediate(() => callback(null)); }
        return true;
    }
    sendToQueue(queue: string, _content: Buffer, _options: any, callback?: any) {
        this.events.push(`sendToQueue:${queue}`);
        if (callback) { setImmediate(() => callback(null)); }
        return true;
    }
    once() { return this; }
    async deliver(msg: any) { if (this.onMessage) { await this.onMessage(msg); } }
}

function request(overrides: any = {}) {
    return {
        content: Buffer.from('payload'),
        fields: { routingKey: 'REQUEST.Svc.Api.doThing' },
        properties: {
            correlationId: 'cid-1',
            replyTo: 'callback.queue',
            headers: {},
            ...(overrides.properties || {}),
        },
    };
}

describe('request settlement ordering', () => {
    it('publishes the reply before acknowledging the request', async () => {
        const conn = new Connection();
        const ch = new OrderingChannel();

        await conn.consume(
            ch as any,
            'Svc.Queue',
            async () => Buffer.from('the-reply'),
            {},
            true, // lateAck
        );
        await ch.deliver(request());

        // Acking first means a crash in the gap loses the reply with the
        // request already settled, so it can never be redelivered.
        expect(ch.events).toEqual(['publish:callback.queue', 'ack']);
    });

    it('publishes every streaming chunk before acknowledging the request', async () => {
        const conn = new Connection();
        const ch = new OrderingChannel();

        async function* chunks() {
            yield Buffer.from('one');
            yield Buffer.from('two');
        }

        await conn.consume(ch as any, 'Svc.Queue', async () => chunks(), {}, true);
        await ch.deliver(request());

        expect(ch.events[ch.events.length - 1]).toBe('ack');
        expect(ch.events.filter(e => e.startsWith('publish:')).length).toBeGreaterThanOrEqual(2);
    });

    it('does not acknowledge the request when the reply publish fails', async () => {
        const conn = new Connection();
        const ch = new OrderingChannel();
        ch.publish = () => { throw new Error('broker went away'); };

        await conn.consume(ch as any, 'Svc.Queue', async () => Buffer.from('r'), {}, true);
        await ch.deliver(request());

        // An unsent reply must leave the request unsettled so it can be
        // redelivered, not acked into the void.
        expect(ch.events).not.toContain('ack');
    });
});

/** Accepts publishes and never replies; streams are driven via _onResult. */
class StreamConnection extends EventEmitter {
    public isConnected = true;
    public isReconnecting = false;

    async openChannel(): Promise<any> {
        return { prefetch: async () => undefined, consume: async () => ({ consumerTag: 't' }), close: async () => undefined };
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
    async publish() { return undefined; }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }
}

/** The correlationId the dispatcher registered for its only in-flight stream. */
function onlyStreamId(d: MessageDispatcher): string {
    const ids = [...(d as any).pendingStreams.keys()];
    expect(ids).toHaveLength(1);
    return ids[0];
}

describe('streaming resource bounds', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

    it('releases the pending-stream slot when the idle timeout fires', async () => {
        const d = new MessageDispatcher(new StreamConnection() as any);
        await d.init();

        const stream = d.publishStreaming(Buffer.from('req'), 'REQUEST.A.B.c', 30);
        const iterator = stream[Symbol.asyncIterator]();

        await expect(iterator.next()).rejects.toBeInstanceOf(StreamTimeoutError);

        // A rejecting next() never triggers return()/throw(), so the entry has
        // to be released by the timeout path itself or it is retained forever.
        expect((d as any).pendingStreams.size).toBe(0);
    });

    it('fails the stream with StreamBackpressureError past the chunk bound', async () => {
        process.env.STREAM_MAX_BUFFERED_CHUNKS = '4';
        const d = new MessageDispatcher(new StreamConnection() as any);
        await d.init();

        const stream = d.publishStreaming(Buffer.from('req'), 'REQUEST.A.B.c', 5000);
        const iterator = stream[Symbol.asyncIterator]();
        const id = onlyStreamId(d);

        // Producer races ahead of a consumer that never iterates.
        for (let i = 0; i < 10; i++) {
            await d._onResult(Buffer.from(`chunk-${i}`), id, {});
        }

        await expect(iterator.next()).rejects.toBeInstanceOf(StreamBackpressureError);
    });

    it('fails the stream with StreamBackpressureError past the byte bound', async () => {
        process.env.STREAM_MAX_BUFFERED_CHUNKS = '1000';
        process.env.STREAM_MAX_BUFFERED_BYTES = '64';
        const d = new MessageDispatcher(new StreamConnection() as any);
        await d.init();

        const stream = d.publishStreaming(Buffer.from('req'), 'REQUEST.A.B.c', 5000);
        const iterator = stream[Symbol.asyncIterator]();
        const id = onlyStreamId(d);

        for (let i = 0; i < 10; i++) {
            await d._onResult(Buffer.alloc(16, i), id, {});
        }

        await expect(iterator.next()).rejects.toBeInstanceOf(StreamBackpressureError);
    });

    it('does not fire backpressure when the consumer keeps up', async () => {
        process.env.STREAM_MAX_BUFFERED_CHUNKS = '4';
        const d = new MessageDispatcher(new StreamConnection() as any);
        await d.init();

        const stream = d.publishStreaming(Buffer.from('req'), 'REQUEST.A.B.c', 5000);
        const iterator = stream[Symbol.asyncIterator]();
        const id = onlyStreamId(d);

        // Draining after each chunk must keep the running byte total honest;
        // if it only ever grew, this would trip the bound partway through.
        for (let i = 0; i < 12; i++) {
            await d._onResult(Buffer.from(`chunk-${i}`), id, {});
            const next = await iterator.next();
            expect(next.done).toBe(false);
            expect(next.value.toString()).toBe(`chunk-${i}`);
        }

        await d._onResult(Buffer.alloc(0), id, { 'x-protobus-final': true });
        expect((await iterator.next()).done).toBe(true);
        expect((d as any).pendingStreams.size).toBe(0);
    });
});
