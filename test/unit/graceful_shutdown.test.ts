import { EventEmitter } from 'events';

import Connection from '../../lib/connection';
import RunnableService from '../../lib/runnable_service';

/**
 * Shutdown must stop intake, drain in-flight handlers, then run the user's
 * cleanup hook — a SIGTERM during normal traffic must not kill work mid-handler
 * or truncate pending log writes.
 *
 * Draining needs a step that stops NEW deliveries while keeping the channel
 * usable, because in-flight handlers still have to ack and publish their
 * replies over it.
 */

function fakeChannel() {
    const ch: any = {
        cancelled: [] as string[],
        acked: 0,
        prefetch: async () => undefined,
        consume: async (_q: string, h: any, opts: any) => {
            ch._h = h;
            return { consumerTag: opts?.consumerTag || 'tag' };
        },
        ack: () => { ch.acked++; },
        reject: () => undefined,
        publish: (_e: string, _r: string, _c: Buffer, _o: any, cb: any) => {
            if (cb) setImmediate(() => cb(null));
            return true;
        },
        sendToQueue: (_q: string, _c: Buffer, _o: any, cb: any) => {
            if (cb) setImmediate(() => cb(null));
            return true;
        },
        cancel: async (tag: string) => { ch.cancelled.push(tag); },
        once: () => ch,
    };
    return ch;
}

const message = (id: string) => ({
    content: Buffer.from('body'),
    fields: { routingKey: 'REQUEST.S.A.m' },
    properties: { correlationId: id, headers: {} },
});

describe('in-flight delivery tracking', () => {
    it('counts a delivery for as long as its handler is running', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });

        await conn.consume(ch, 'Q', async () => { await gate; return undefined; }, {}, true);

        expect(conn.inFlightDeliveries).toBe(0);

        const delivery = ch._h(message('cid-1'));
        await new Promise((r) => setImmediate(r));

        // Without this, shutdown has no way to know work is outstanding.
        expect(conn.inFlightDeliveries).toBe(1);

        release();
        await delivery;
        expect(conn.inFlightDeliveries).toBe(0);
    });

    it('drains once in-flight handlers finish', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        await conn.consume(ch, 'Q', async () => { await gate; return undefined; }, {}, true);

        const delivery = ch._h(message('cid-2'));
        await new Promise((r) => setImmediate(r));

        let drained = false;
        const drain = conn.drainInFlight(5000).then(() => { drained = true; });

        await new Promise((r) => setImmediate(r));
        expect(drained).toBe(false); // still working

        release();
        await delivery;
        await drain;
        expect(drained).toBe(true);
    });

    it('gives up draining at the deadline rather than hanging shutdown', async () => {
        const conn = new Connection();
        const ch = fakeChannel();

        // A handler that never returns — the case a deadline exists for.
        await conn.consume(ch, 'Q', () => new Promise<any>(() => { /* never */ }), {}, true);
        ch._h(message('cid-3'));
        await new Promise((r) => setImmediate(r));

        const settled = await conn.drainInFlight(30);
        // Reports that work was abandoned, instead of blocking forever.
        expect(settled).toBe(false);
        expect(conn.inFlightDeliveries).toBe(1);
    });

    it('resolves immediately when nothing is in flight', async () => {
        const conn = new Connection();
        expect(await conn.drainInFlight(5000)).toBe(true);
    });
});

describe('shutdown ordering', () => {
    it('stops intake and drains before running user cleanup', async () => {
        const order: string[] = [];

        const connection: any = Object.assign(new EventEmitter(), {
            isConnected: true,
            inFlightDeliveries: 1,
            drainInFlight: async () => { order.push('drain'); return true; },
            disconnect: async () => { order.push('disconnect'); },
        });
        const context: any = { connection, factory: {} };

        class Svc extends (RunnableService as any) {
            get ServiceName() { return 'T.Service'; }
            get Proto() { return ''; }
            async init() { order.push('init'); }
            async stopConsuming() { order.push('stopConsuming'); }
            async cleanup() { order.push('cleanup'); }
        }

        const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
        process.env.SHUTDOWN_EXIT_GRACE_MS = '10000'; // keep the backstop out of the way

        await (RunnableService as any).start(context, Svc);
        process.emit('SIGTERM' as any);
        await new Promise((r) => setTimeout(r, 50));

        // Cleanup must come AFTER intake stops and in-flight work drains:
        // running it first could close the database a live handler is using.
        expect(order).toEqual(['init', 'stopConsuming', 'drain', 'cleanup', 'disconnect']);
        // The status is set rather than the process torn down mid-flush.
        expect(process.exitCode).toBe(0);
        expect(exitSpy).not.toHaveBeenCalled();

        process.exitCode = undefined;
        exitSpy.mockRestore();
        delete process.env.SHUTDOWN_EXIT_GRACE_MS;
    });
});
