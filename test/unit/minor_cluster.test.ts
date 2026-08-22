import { EventEmitter } from 'events';
import Connection from '../../lib/connection';
import MessageDispatcher from '../../lib/message_dispatcher';
import Config from '../../lib/config';
import MessageListener from '../../lib/message_listener';

describe('a drained listener stays drained across a reconnection', () => {
    it('does not resume consuming after stopConsuming', async () => {
        const conn: any = new EventEmitter();
        conn.isConnected = true;
        conn.registerRestorer = (fn: any) => { conn._restore = fn; return () => undefined; };
        conn.openChannel = async () => ({ prefetch: async () => undefined });
        conn.declareExchange = async () => undefined;
        conn.declareQueue = async () => 'Svc';
        conn.bindQueue = async () => undefined;
        conn.cancel = async () => undefined;
        let consumeCalls = 0;
        conn.consume = async () => { consumeCalls++; };

        const listener = new MessageListener(conn, true, 1);
        await listener.init(async () => undefined, 'Svc');
        await listener.start();
        expect(consumeCalls).toBe(1);

        await listener.stopConsuming();
        await conn._restore(1);

        // A shutdown in progress must not be undone by a reconnection.
        expect(consumeCalls).toBe(1);
    });
});

describe('a confirmed publish is not reported as unconfirmed', () => {
    it('resolves when the write buffer never drains, rather than timing out', async () => {
        const saved = process.env.PUBLISH_CONFIRM_TIMEOUT_MS;
        process.env.PUBLISH_CONFIRM_TIMEOUT_MS = '60';
        try {
            const conn: any = new Connection();
            const ch: any = new EventEmitter();
            let confirm!: (err: any) => void;
            // Reports a full write buffer, and never emits 'drain'.
            ch.publish = (_e: string, _r: string, _c: Buffer, _p: any, cb: any) => { confirm = cb; return false; };
            conn._publishStateFor(ch);

            const p = conn.publish(ch, 'ex', 'rk', Buffer.alloc(1), {});
            await new Promise((r) => setImmediate(r));
            confirm(null); // the broker DID confirm

            await expect(p).resolves.toBeUndefined();
        } finally {
            if (saved === undefined) { delete process.env.PUBLISH_CONFIRM_TIMEOUT_MS; }
            else { process.env.PUBLISH_CONFIRM_TIMEOUT_MS = saved; }
        }
    });
});

describe('streaming buffers are bounded in aggregate, not only per call', () => {
    it('fails a stream once the dispatcher total is exceeded', async () => {
        const saved = process.env.STREAM_MAX_TOTAL_BUFFERED_BYTES;
        process.env.STREAM_MAX_TOTAL_BUFFERED_BYTES = '3000';
        try {
            const conn: any = new EventEmitter();
            conn.isConnected = true;
            conn.isReconnecting = false;
            conn.whenReady = async () => undefined;
            conn.registerRestorer = () => () => undefined;
            conn.publish = async () => undefined;
            const d: any = new MessageDispatcher(conn);
            d.channel = {};
            d.callbackListener = { callbackQueue: 'cb' };

            const ids: string[] = [];
            for (let i = 0; i < 4; i++) {
                d.publishStreaming(Buffer.alloc(0), 'REQUEST.X.Y.z', 60000);
            }
            ids.push(...d.pendingStreams.keys());

            // 1000 bytes each: the fourth crosses the 3000-byte aggregate.
            for (const id of ids) {
                await d._onResult(Buffer.alloc(1000), id, { [Config.HEADER_SEQ]: 0 });
            }

            const failed = ids.filter((id) => d.pendingStreams.get(id)?.error);
            expect(failed.length).toBeGreaterThan(0);
            expect(d.pendingStreams.get(failed[0])!.error.name).toBe('StreamBackpressureError');
        } finally {
            if (saved === undefined) { delete process.env.STREAM_MAX_TOTAL_BUFFERED_BYTES; }
            else { process.env.STREAM_MAX_TOTAL_BUFFERED_BYTES = saved; }
        }
    });
});
