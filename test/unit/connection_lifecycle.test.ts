import { EventEmitter } from 'events';
import * as amqplib from 'amqplib';

import Connection from '../../lib/connection';
import { ILogger, set as setLogger, DefaultLogger } from '../../lib/logger';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Connection state-machine findings from the audit: concurrent connects, a
 * manual disconnect racing an in-flight reconnect, and a misreported attempt
 * count. All three are invisible until the network misbehaves, which is
 * exactly when you are relying on this code.
 */

/** A fake amqplib connection handle. */
class FakeHandle extends EventEmitter {
    public closed = false;
    constructor(public label: string) { super(); }
    async close() { this.closed = true; this.emit('close'); }
    async createConfirmChannel() { return { close: async () => undefined }; }
}

/** A promise whose resolution the test controls. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: any) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
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

describe('connection lifecycle', () => {
    afterEach(() => {
        jest.clearAllMocks();
        setLogger(new DefaultLogger());
    });

    it('is single-flight: concurrent connects share one broker connection', async () => {
        const handle = new FakeHandle('first');
        let calls = 0;
        (amqplib.connect as jest.Mock).mockImplementation(async () => { calls++; return handle; });

        const conn = new Connection();
        const [a, b, c] = await Promise.all([
            conn.connect('amqp://localhost'),
            conn.connect('amqp://localhost'),
            conn.connect('amqp://localhost'),
        ]);

        // Without single-flight each caller opens its own socket and the last
        // one wins `this.handle`, orphaning the others with no way to close
        // them — a silent file-descriptor and broker-connection leak.
        expect(calls).toBe(1);
        expect(a).toBe(handle);
        expect(b).toBe(handle);
        expect(c).toBe(handle);
    });

    it('does not come back up when disconnect races an in-flight reconnect', async () => {
        const first = new FakeHandle('first');
        const late = new FakeHandle('late');
        const secondConnect = deferred<any>();

        let n = 0;
        (amqplib.connect as jest.Mock).mockImplementation(() => {
            n++;
            return n === 1 ? Promise.resolve(first) : secondConnect.promise;
        });

        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });

        // Broker drops us; a reconnect is scheduled and starts connecting.
        first.emit('close');
        await new Promise((r) => setTimeout(r, 20));
        expect(n).toBe(2); // the reconnect attempt is in flight

        // Operator shuts the service down while that attempt is still pending.
        await conn.disconnect();

        // The in-flight attempt now completes. Clearing the timer cannot stop
        // it — it had already fired — so without a generation check this
        // resurrects a connection the caller explicitly tore down.
        secondConnect.resolve(late);
        await tick();
        await tick();

        expect(conn.isConnected).toBe(false);
        expect(conn.isReconnecting).toBe(false);
        // The orphaned handle must not be left open on the broker.
        expect(late.closed).toBe(true);
    });

    it('reports the real number of reconnection attempts', async () => {
        const log = new CapturingLogger();
        setLogger(log);

        const first = new FakeHandle('first');
        const revived = new FakeHandle('revived');
        let n = 0;
        (amqplib.connect as jest.Mock).mockImplementation(async () => {
            n++;
            if (n === 1) return first;
            if (n === 2) throw new Error('still down');
            return revived;
        });

        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 5 });
        first.emit('close');

        await new Promise((r) => setTimeout(r, 80));

        // _connect() zeroes the counter on success, so reading it afterwards
        // always said "after 0 attempts" no matter how long the outage was.
        expect(log.text).toContain('reconnection successful after 2 attempts');
        expect(log.text).not.toContain('after 0 attempts');
    });
});
