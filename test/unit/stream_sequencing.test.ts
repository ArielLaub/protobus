import { EventEmitter } from 'events';

import MessageDispatcher from '../../lib/message_dispatcher';
import Config from '../../lib/config';
import { StreamSequenceError } from '../../lib/errors';

/**
 * The server stamps every streaming chunk with x-protobus-seq, but the client
 * never read it. A dropped chunk therefore produced a silently truncated
 * stream — the caller saw a short but apparently successful result, which is
 * the worst possible failure mode for streamed data.
 */

class StubConnection extends EventEmitter {
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
    async publishToQueue() { return undefined; }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }
}

async function newDispatcher() {
    const d = new MessageDispatcher(new StubConnection() as any);
    await d.init();
    return d;
}

function streamId(d: MessageDispatcher): string {
    return [...(d as any).pendingStreams.keys()][0];
}

const chunk = (seq: number, body: string, final = false) => ({
    body: Buffer.from(body),
    headers: { [Config.HEADER_SEQ]: seq, [Config.HEADER_FINAL]: final },
});

describe('streaming sequence validation', () => {
    it('accepts chunks arriving in order', async () => {
        const d = await newDispatcher();
        const it = d.publishStreaming(Buffer.from('req'), 'R.A.B.c', 5000)[Symbol.asyncIterator]();
        const id = streamId(d);

        for (const [i, text] of ['a', 'b', 'c'].entries()) {
            const c = chunk(i, text);
            await d._onResult(c.body, id, c.headers);
            expect((await it.next()).value.toString()).toBe(text);
        }
    });

    it('fails the stream when a chunk is missing', async () => {
        const d = await newDispatcher();
        const it = d.publishStreaming(Buffer.from('req'), 'R.A.B.c', 5000)[Symbol.asyncIterator]();
        const id = streamId(d);

        const first = chunk(0, 'a');
        await d._onResult(first.body, id, first.headers);
        expect((await it.next()).value.toString()).toBe('a');

        // seq 1 never arrives. Silently yielding 'c' would hand the caller an
        // incomplete result it has no way to detect.
        const third = chunk(2, 'c');
        await d._onResult(third.body, id, third.headers);

        await expect(it.next()).rejects.toBeInstanceOf(StreamSequenceError);
        expect((d as any).pendingStreams.size).toBe(0);
    });

    it('drops a duplicate chunk instead of yielding it twice', async () => {
        const d = await newDispatcher();
        const it = d.publishStreaming(Buffer.from('req'), 'R.A.B.c', 5000)[Symbol.asyncIterator]();
        const id = streamId(d);

        const a = chunk(0, 'a');
        await d._onResult(a.body, id, a.headers);
        await d._onResult(a.body, id, a.headers); // redelivery

        expect((await it.next()).value.toString()).toBe('a');

        const b = chunk(1, 'b', true);
        await d._onResult(b.body, id, b.headers);
        expect((await it.next()).value.toString()).toBe('b');
        expect((await it.next()).done).toBe(true);
    });

    it('stays compatible with a server that sends no sequence header', async () => {
        const d = await newDispatcher();
        const it = d.publishStreaming(Buffer.from('req'), 'R.A.B.c', 5000)[Symbol.asyncIterator]();
        const id = streamId(d);

        // A 1.x server stamps no x-protobus-seq. Validation must not invent a
        // violation where the information simply is not present.
        await d._onResult(Buffer.from('a'), id, {});
        await d._onResult(Buffer.from('b'), id, {});

        expect((await it.next()).value.toString()).toBe('a');
        expect((await it.next()).value.toString()).toBe('b');
    });
});
