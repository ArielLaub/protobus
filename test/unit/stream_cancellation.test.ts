import Connection from '../../lib/connection';

/**
 * Server-side reaction to a cancelled stream.
 *
 * A client that stops consuming must be able to stop the producer, not merely
 * stop listening to it. An LLM token stream abandoned when the user presses
 * Stop should stop costing tokens; a stream feeding a UI that closed should
 * stop doing work.
 *
 * Cancellation is cooperative — JavaScript cannot preempt a running generator —
 * so the contract is: the handler's AbortSignal fires, and the framework stops
 * publishing whatever the generator produces after that point.
 */

function fakeChannel() {
    const ch: any = {
        published: [] as Array<{ routingKey: string; body: Buffer; options: any }>,
        acked: 0,
        prefetch: async () => undefined,
        consume: async (_q: string, h: any) => { ch._h = h; return { consumerTag: 't' }; },
        ack: () => { ch.acked++; },
        reject: () => undefined,
        publish: (_e: string, routingKey: string, body: Buffer, options: any, cb: any) => {
            ch.published.push({ routingKey, body, options });
            if (cb) setImmediate(() => cb(null));
            return true;
        },
        sendToQueue: (_q: string, _c: Buffer, _o: any, cb: any) => {
            if (cb) setImmediate(() => cb(null));
            return true;
        },
        once: () => ch,
    };
    return ch;
}

const streamRequest = (correlationId: string) => ({
    content: Buffer.from('req'),
    fields: { routingKey: 'REQUEST.S.A.stream' },
    properties: { correlationId, replyTo: 'callback.q', headers: {} },
});

const tick = () => new Promise((r) => setImmediate(r));

describe('server-side stream cancellation', () => {
    it('aborts the handler signal when the stream is cancelled', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        let seenSignal: AbortSignal | undefined;
        let aborted = false;

        await conn.consume(ch, 'Q', async (_c, _id, _h, context) => {
            seenSignal = context!.signal;
            context!.signal.addEventListener('abort', () => { aborted = true; });
            // A generator that keeps going until told to stop.
            return (async function* () {
                for (let i = 0; i < 1000; i++) {
                    if (context!.signal.aborted) return;
                    yield Buffer.from(`chunk-${i}`);
                    await new Promise((r) => setTimeout(r, 1));
                }
            })();
        }, {}, true);

        const delivery = ch._h(streamRequest('cid-cancel'));
        await tick();
        expect(seenSignal).toBeDefined();

        expect(conn.cancelStream('cid-cancel')).toBe(true);
        await delivery;

        expect(aborted).toBe(true);
        // Far short of the 1000 the generator would have produced unaided.
        expect(ch.published.length).toBeLessThan(100);
    });

    it('stops publishing chunks once cancelled', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        // A deliberately UNCOOPERATIVE generator: it ignores the signal.
        await conn.consume(ch, 'Q', async () => (async function* () {
            for (let i = 0; i < 50; i++) {
                yield Buffer.from(`chunk-${i}`);
                await new Promise((r) => setTimeout(r, 1));
            }
        })(), {}, true);

        const delivery = ch._h(streamRequest('cid-uncoop'));
        await tick();
        conn.cancelStream('cid-uncoop');
        await delivery;

        // The framework cannot stop the generator, but it must stop sending its
        // output to a caller that has gone away.
        expect(ch.published.length).toBeLessThan(50);
    });

    it('acknowledges a cancelled request instead of retrying it', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        await conn.consume(ch, 'Q', async (_c, _id, _h, context) => (async function* () {
            while (!context!.signal.aborted) {
                yield Buffer.from('x');
                await new Promise((r) => setTimeout(r, 1));
            }
        })(), {}, true, {
            maxRetries: 3,
            retryQueueName: 'Q.Retry',
            retryExchangeName: 'Q.Retry.Ex',
            dlqName: 'Q.DLQ',
        });

        const delivery = ch._h(streamRequest('cid-ack'));
        await tick();
        conn.cancelStream('cid-ack');
        await delivery;

        // Cancellation is a normal outcome, not a failure to retry or DLQ.
        expect(ch.acked).toBe(1);
    });

    it('reports false when cancelling a stream it does not know about', async () => {
        const conn = new Connection();
        expect(conn.cancelStream('never-heard-of-it')).toBe(false);
    });

    it('releases its bookkeeping when the stream finishes normally', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        await conn.consume(ch, 'Q', async () => (async function* () {
            yield Buffer.from('only');
        })(), {}, true);

        await ch._h(streamRequest('cid-done'));

        expect(conn.cancelStream('cid-done')).toBe(false);
    });
});
