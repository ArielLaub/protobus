import { EventEmitter } from 'events';
import * as amqplib from 'amqplib';

import Connection from '../../lib/connection';
import { BaseListener } from '../../lib/base_listener';
import { set as setLogger, DefaultLogger } from '../../lib/logger';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * `stopConsuming()` is the first step of a graceful shutdown: stop taking new
 * work, then drain what is in hand. A disconnect deliberately clears
 * `consumerTag` while keeping the listener enrolled in restoration, because it
 * has to come back when the broker does — so the shutdown step cannot use a
 * consumerTag as its evidence that there is anything to stop.
 */

class FakeHandle extends EventEmitter {
    public closed = false;
    constructor(public label: string) { super(); }
    async close() { this.closed = true; this.emit('close'); }
    async createConfirmChannel() {
        return {
            close: async () => undefined,
            prefetch: async () => undefined,
            assertExchange: async () => undefined,
            assertQueue: async () => ({ queue: 'q' }),
            bindQueue: async () => undefined,
            consume: async () => ({ consumerTag: 'tag' }),
            cancel: async () => undefined,
            publish: (_e: string, _r: string, _c: Buffer, _o: any, cb: any) => { setImmediate(() => cb(null)); return true; },
            on: () => undefined,
            once: () => undefined,
        };
    }
}

const tick = () => new Promise((r) => setImmediate(r));
/** The reconnect backoff is real time even at initialDelayMs 1. */
const settleReconnect = async () => {
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 5)); }
};

class ProbeListener extends BaseListener {
    constructor(connection: any) {
        super(connection);
        this.exchangeName = 'probe.exchange';
        this.exchangeType = 'topic';
    }
    get wasStarted(): boolean { return (this as any)._wasStarted; }
    get restorerAttached(): boolean { return (this as any)._restorerAttached; }
}

/**
 * Connect once immediately; hold every reconnection behind a barrier so the
 * shutdown can be made to land inside the disconnected window rather than
 * racing it.
 */
function gatedBroker() {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (amqplib.connect as jest.Mock).mockImplementation(async () => {
        calls += 1;
        if (calls > 1) await gate;
        return new FakeHandle(`h${calls}`);
    });
    return { release: () => release() };
}

describe('graceful shutdown while the broker is away', () => {
    afterEach(() => { jest.clearAllMocks(); setLogger(new DefaultLogger()); });

    it('does not resume consuming when the broker comes back mid-shutdown', async () => {
        const broker = gatedBroker();
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        const listener = new ProbeListener(conn);
        await listener.init(async () => undefined, 'probe.queue');
        await listener.start();

        // Only consumes started AFTER the shutdown decision are interesting.
        const consumeSpy = jest.spyOn(conn, 'consume');

        (conn as any).handle.emit('close');
        await tick();

        // The precondition the bug depends on: the disconnect drops the tag but
        // keeps the listener enrolled, so it can come back with the broker.
        expect((listener as any).consumerTag).toBe('');
        expect(listener.wasStarted).toBe(true);

        // SIGTERM lands here, with the broker still away.
        await listener.stopConsuming();

        broker.release();
        await settleReconnect();

        // A process that has begun shutting down must not start taking new
        // work when the socket comes back.
        expect(consumeSpy).not.toHaveBeenCalled();
        expect(listener.wasStarted).toBe(false);
        expect(listener.restorerAttached).toBe(false);
    });

    it('still cancels the broker-side consumer when it is connected', async () => {
        gatedBroker();
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        const listener = new ProbeListener(conn);
        await listener.init(async () => undefined, 'probe.queue');
        await listener.start();

        const tag = (listener as any).consumerTag;
        expect(tag).toBeTruthy();

        const cancelSpy = jest.spyOn(conn, 'cancel');
        await listener.stopConsuming();

        // Clearing the state first must not cost the broker-side cancel, which
        // is the whole point of the call when the connection is healthy.
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(cancelSpy.mock.calls[0][1]).toBe(tag);
    });

    it('is safe to call more than once, and while disconnected', async () => {
        gatedBroker();
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        const listener = new ProbeListener(conn);
        await listener.init(async () => undefined, 'probe.queue');
        await listener.start();

        const cancelSpy = jest.spyOn(conn, 'cancel');
        await listener.stopConsuming();
        await expect(listener.stopConsuming()).resolves.toBeUndefined();

        (conn as any).handle.emit('close');
        await tick();
        await expect(listener.stopConsuming()).resolves.toBeUndefined();

        // The consumer is cancelled once; the repeats are no-ops, not errors
        // and not a second cancel of a tag that is already gone.
        expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
});
