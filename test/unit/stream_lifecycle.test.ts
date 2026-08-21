import { EventEmitter, getEventListeners } from 'events';
import MessageDispatcher from '../../lib/message_dispatcher';
import Config from '../../lib/config';

function fakeConnection() {
    const conn: any = new EventEmitter();
    conn.isConnected = true;
    conn.isReconnecting = false;
    conn.isReady = true;
    conn.whenReady = async () => undefined;
    conn.registerRestorer = () => () => undefined;
    conn.openChannel = async () => ({});
    conn.published = [];
    conn.publish = async (_ch: any, exchange: string, _rk: string, _c: Buffer, props: any) => {
        conn.published.push({ exchange, correlationId: props?.correlationId });
    };
    return conn;
}

function dispatcher(conn: any) {
    const d: any = new MessageDispatcher(conn);
    d.channel = {};
    d.callbackListener = { callbackQueue: 'cb' };
    d._isInitialized = true;
    return d;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('streaming call lifetime', () => {
    it('does not leak a stream that is never iterated', async () => {
        jest.useFakeTimers();
        try {
            const d = dispatcher(fakeConnection());
            for (let i = 0; i < 50; i++) {
                d.publishStreaming(Buffer.alloc(0), 'REQUEST.X.Y.z', 1000);
            }
            expect(d.pendingStreams.size).toBe(50);
            // Nothing ever iterates them; the idle deadline must still fire.
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            expect(d.pendingStreams.size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('releases the caller signal when a stream ends normally', async () => {
        const conn = fakeConnection();
        const d = dispatcher(conn);
        const ac = new AbortController();

        for (let i = 0; i < 20; i++) {
            const iter = d.publishStreaming(Buffer.alloc(0), 'REQUEST.X.Y.z', 1000, { signal: ac.signal });
            const it = iter[Symbol.asyncIterator]();
            const next = it.next();
            const id = [...d.pendingStreams.keys()][0];
            await flush();
            // Terminal, empty-bodied reply: end of stream.
            await d._onResult(Buffer.alloc(0), id, { [Config.HEADER_FINAL]: true });
            expect((await next).done).toBe(true);
        }

        expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    });

    it('tells the producer to stop when the stream times out idle', async () => {
        const conn = fakeConnection();
        const d = dispatcher(conn);
        const iter = d.publishStreaming(Buffer.alloc(0), 'REQUEST.X.Y.z', 20);
        const it = iter[Symbol.asyncIterator]();
        await expect(it.next()).rejects.toThrow(/within 20ms/);

        const cancels = conn.published.filter((p: any) => p.exchange === Config.cancelExchangeName);
        expect(cancels).toHaveLength(1);
    });

    it('publishes nothing for a call whose signal is already aborted', async () => {
        const conn = fakeConnection();
        const d = dispatcher(conn);
        const ac = new AbortController();
        ac.abort();

        const iter = d.publishStreaming(Buffer.alloc(4), 'REQUEST.X.Y.z', 1000, { signal: ac.signal });
        const it = iter[Symbol.asyncIterator]();
        expect((await it.next()).done).toBe(true);
        await flush();
        expect(conn.published).toHaveLength(0);
        expect(d.pendingStreams.size).toBe(0);
    });
});
