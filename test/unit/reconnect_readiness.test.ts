import { EventEmitter } from 'events';
import * as amqplib from 'amqplib';

import Connection from '../../lib/connection';
import { BaseListener } from '../../lib/base_listener';
import MessageDispatcher from '../../lib/message_dispatcher';
import { ILogger, set as setLogger, DefaultLogger } from '../../lib/logger';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

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

class CapturingLogger implements ILogger {
    public lines: string[] = [];
    info(m: any) { this.lines.push(String(m)); }
    warn(m: any) { this.lines.push(String(m)); }
    debug(m: any) { this.lines.push(String(m)); }
    error(m: any) { this.lines.push(String(m)); }
    get text() { return this.lines.join('\n'); }
}

const tick = () => new Promise((r) => setImmediate(r));
/**
 * Let the reconnect timers actually fire. The backoff is real time even at
 * initialDelayMs 1, so spinning setImmediate is not enough on its own.
 */
const settleReconnect = async () => {
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 5)); }
};

/** Minimal concrete BaseListener for exercising restoration. */
class ProbeListener extends BaseListener {
    public restores = 0;
    public failNextRestore = false;
    constructor(connection: any) {
        super(connection);
        this.exchangeName = 'probe.exchange';
        this.exchangeType = 'topic';
    }
    protected async _reinitialize(): Promise<void> {
        this.restores++;
        if (this.failNextRestore) {
            this.failNextRestore = false;
            throw new Error('queue declaration refused');
        }
        return super._reinitialize();
    }
}

describe('reconnection is not announced until the topology is back', () => {
    let unhandled: any[] = [];
    const onUnhandled = (err: any) => unhandled.push(err);

    beforeEach(() => { unhandled = []; process.on('unhandledRejection', onUnhandled); });
    afterEach(() => {
        process.removeListener('unhandledRejection', onUnhandled);
        jest.clearAllMocks();
        setLogger(new DefaultLogger());
    });

    it('withholds reconnected until every restorer has resolved', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        const order: string[] = [];
        let release!: () => void;
        const blocked = new Promise<void>((r) => { release = r; });

        conn.registerRestorer!(async () => { order.push('restore:start'); await blocked; order.push('restore:done'); });
        conn.on('reconnected', () => order.push('reconnected'));

        (conn as any).handle.emit('close');
        await settleReconnect();

        expect(order).toEqual(['restore:start']);
        expect(conn.isReady).toBe(false);

        release();
        await settleReconnect();

        expect(order).toEqual(['restore:start', 'restore:done', 'reconnected']);
        expect(conn.isReady).toBe(true);
    });

    it('has a usable dispatcher channel by the time reconnected fires', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        const dispatcher = new MessageDispatcher(conn);
        await dispatcher.init();

        let channelAtAnnouncement: unknown = 'not-observed';
        conn.on('reconnected', () => { channelAtAnnouncement = (dispatcher as any).channel; });

        (conn as any).handle.emit('close');
        await settleReconnect();

        expect(channelAtAnnouncement).toBeDefined();
        expect(channelAtAnnouncement).not.toBe('not-observed');
        await dispatcher.close();
    });

    it('retries instead of announcing when a restorer fails, without an unhandled rejection', async () => {
        const log = new CapturingLogger();
        setLogger(log);
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        let attempts = 0;
        let announced = 0;
        conn.on('reconnected', () => { announced++; });
        conn.on('error', () => undefined);
        conn.registerRestorer!(async () => {
            attempts++;
            if (attempts < 3) throw new Error('queue declaration refused');
        });

        (conn as any).handle.emit('close');
        await settleReconnect();

        expect(attempts).toBeGreaterThanOrEqual(3);
        expect(announced).toBe(1);
        expect(conn.isReady).toBe(true);
        expect(unhandled).toHaveLength(0);
    });

    it('gives up through the existing maxRetries budget when restoration keeps failing', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 2 });

        const errors: Error[] = [];
        conn.on('error', (e) => errors.push(e));
        conn.registerRestorer!(async () => { throw new Error('always broken'); });

        (conn as any).handle.emit('close');
        await settleReconnect();

        expect(errors.some((e) => /max reconnection attempts/.test(e.message))).toBe(true);
        expect(conn.isReady).toBe(false);
        expect(unhandled).toHaveLength(0);
    });

    it('unregisters a restorer so a closed component is not restored again', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        let calls = 0;
        const unregister = conn.registerRestorer!(async () => { calls++; });
        unregister();

        (conn as any).handle.emit('close');
        await settleReconnect();

        expect(calls).toBe(0);
    });

    it('reports a listener restore failure to the coordinator rather than an unwatched error event', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        const listener = new ProbeListener(conn);
        await listener.init(async () => undefined, 'probe.queue');
        listener.failNextRestore = true;

        let announced = 0;
        conn.on('reconnected', () => { announced++; });
        conn.on('error', () => undefined);

        (conn as any).handle.emit('close');
        await settleReconnect();

        // One failed restore, then a successful retry — and only then the announcement.
        expect(listener.restores).toBeGreaterThanOrEqual(2);
        expect(announced).toBe(1);
        expect(unhandled).toHaveLength(0);
    });
});

describe('readiness is available to publishers', () => {
    afterEach(() => { jest.clearAllMocks(); setLogger(new DefaultLogger()); });

    it('is ready after the initial connect', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        expect(conn.isReady).toBe(false);
        await conn.connect('amqp://localhost', { initialDelayMs: 1 });
        expect(conn.isReady).toBe(true);
        await expect(conn.whenReady()).resolves.toBeUndefined();
    });

    it('parks whenReady across a reconnection and resolves once restored', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        (conn as any).handle.emit('close');
        expect(conn.isReady).toBe(false);

        const waiting = conn.whenReady();
        await settleReconnect();
        await expect(waiting).resolves.toBeUndefined();
    });

    it('rejects a parked waiter when the connection is deliberately closed', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        (conn as any).handle.emit('close');
        const waiting = conn.whenReady();
        await conn.disconnect();

        await expect(waiting).rejects.toThrow();
    });
});

describe('publishers wait through a reconnection', () => {
    afterEach(() => { jest.clearAllMocks(); setLogger(new DefaultLogger()); });

    it('parks a publish issued mid-reconnection and completes it once restored', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });
        const dispatcher = new MessageDispatcher(conn);
        await dispatcher.init();

        (conn as any).handle.emit('close');
        expect(conn.isConnected).toBe(false);

        // Issued while there is no channel at all: it must wait, not blow up
        // on an undefined one.
        const inFlight = dispatcher.publish(Buffer.from('body'), 'REQUEST.P.S.go', false);
        await settleReconnect();

        await expect(inFlight).resolves.toBeUndefined();
        await dispatcher.close();
    });

    it('publishes successfully from a reconnected handler', async () => {
        (amqplib.connect as jest.Mock).mockImplementation(async () => new FakeHandle('h'));
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });
        const dispatcher = new MessageDispatcher(conn);
        await dispatcher.init();

        let outcome: string = 'never ran';
        conn.on('reconnected', () => {
            dispatcher.publish(Buffer.from('body'), 'REQUEST.P.S.go', false)
                .then(() => { outcome = 'published'; })
                .catch((err) => { outcome = `failed: ${err.message}`; });
        });

        (conn as any).handle.emit('close');
        await settleReconnect();

        expect(outcome).toBe('published');
        await dispatcher.close();
    });

    it('still reports a never-connected dispatcher at once', async () => {
        const conn = new Connection();
        const dispatcher = new MessageDispatcher(conn);
        await expect(dispatcher.publish(Buffer.from('b'), 'REQUEST.P.S.go', false)).rejects.toThrow();
    });
});

describe('an IConnection without registerRestorer still reconnects', () => {
    afterEach(() => { jest.clearAllMocks(); setLogger(new DefaultLogger()); });

    it('falls back to the reconnected event', async () => {
        const legacy: any = new EventEmitter();
        legacy.isConnected = true;
        legacy.isReconnecting = false;
        legacy.openChannel = async () => ({ close: async () => undefined });
        legacy.cancel = async () => undefined;
        // Deliberately no registerRestorer, no whenReady — an older custom
        // implementation of the public IConnection interface.

        const dispatcher = new MessageDispatcher(legacy);
        (dispatcher as any)._isInitialized = true;
        (dispatcher as any).channel = undefined;

        legacy.emit('reconnected');
        for (let i = 0; i < 10; i++) { await tick(); }

        expect((dispatcher as any).channel).toBeDefined();
    });
});
