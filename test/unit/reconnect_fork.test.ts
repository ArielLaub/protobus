import { EventEmitter } from 'events';
import * as amqplib from 'amqplib';
import Connection from '../../lib/connection';
import { BaseListener } from '../../lib/base_listener';
jest.mock('amqplib', () => ({ connect: jest.fn() }));

class FakeHandle extends EventEmitter {
    public closed = false;
    constructor(public label: string) { super(); }
    async close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
    async createConfirmChannel() {
        return {
            close: async () => undefined, prefetch: async () => undefined,
            assertExchange: async () => undefined, assertQueue: async () => ({ queue: 'q' }),
            bindQueue: async () => undefined, consume: async () => ({ consumerTag: 'tag' }),
            cancel: async () => undefined,
            publish: (_e: any, _r: any, _c: any, _o: any, cb: any) => { setImmediate(() => cb(null)); return true; },
            on: () => undefined, once: () => undefined,
        };
    }
}
const settle = async () => { for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 5)); } };

function mockHandles(): FakeHandle[] {
    const handles: FakeHandle[] = [];
    (amqplib.connect as jest.Mock).mockImplementation(async () => {
        const h = new FakeHandle('h' + handles.length); handles.push(h); return h;
    });
    return handles;
}

/** Counts how many times the connection asked it to rebuild its topology. */
class ProbeListener extends BaseListener {
    public restores = 0;
    constructor(connection: any) {
        super(connection);
        this.exchangeName = 'probe.exchange';
        this.exchangeType = 'topic';
    }
    protected async _reinitialize(): Promise<void> {
        this.restores++;
        return super._reinitialize();
    }
}

describe('a reconnection is one lineage, whatever happens mid-restore', () => {
  it('does not fork into two connections when the socket drops during restoration', async () => {
    const handles: FakeHandle[] = [];
    (amqplib.connect as jest.Mock).mockImplementation(async () => {
        const h = new FakeHandle('h' + handles.length); handles.push(h); return h;
    });
    const conn = new Connection();
    await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 8 });

    let dropped = false; let announced = 0;
    conn.on('reconnected', () => { announced++; });
    conn.on('error', () => undefined);
    conn.registerRestorer!(async () => {
        if (!dropped) {
            dropped = true;
            const h = (conn as any).handle as FakeHandle;
            await Promise.resolve();
            h.emit('close');                       // socket dies mid-restore
            await new Promise(r => setImmediate(r));
            throw new Error('channel gone during restore');
        }
    });

    (conn as any).handle.emit('close');
    await settle();

    const stillOpen = handles.slice(1).filter(h => !h.closed);
     
    console.log(`announced=${announced} connects=${handles.length} orphaned=${stillOpen.length}`);
    expect(announced).toBe(1);
    expect(stillOpen).toHaveLength(1);
  });

  it('announces once, on a live socket, when the drop lands mid-restore but restoration succeeds', async () => {
    // The branch that leans entirely on retiring the generation: nothing
    // fails, so there is no error to route the retry through.
    const handles = mockHandles();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
        const conn = new Connection();
        await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 8 });

        let dropped = false; let announced = 0;
        conn.on('reconnected', () => { announced++; });
        conn.on('error', () => undefined);
        conn.registerRestorer!(async () => {
            if (!dropped) {
                dropped = true;
                const h = (conn as any).handle as FakeHandle;
                await Promise.resolve();
                h.emit('close');   // dies mid-restore, but the restorer resolves
            }
        });

        (conn as any).handle.emit('close');
        await settle();

        expect(announced).toBe(1);
        expect(conn.isReady).toBe(true);
        expect(conn.isReconnecting).toBe(false);
        // Whatever was announced must not be a socket we already know is dead.
        expect((conn as any).handle.closed).toBe(false);
        expect(handles.slice(1).filter(h => !h.closed)).toHaveLength(1);
        expect(unhandled).toHaveLength(0);
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('keeps a stopped-then-restarted listener taking part in restoration', async () => {
    mockHandles();
    const conn = new Connection();
    await conn.connect('amqp://localhost', { initialDelayMs: 1, maxRetries: 8 });
    conn.on('error', () => undefined);

    const listener = new ProbeListener(conn);
    await listener.init(async () => undefined, 'probe.queue');
    await listener.start();
    // A partial drain the operator then changes their mind about.
    await listener.stopConsuming();
    await listener.start();

    (conn as any).handle.emit('close');
    await settle();

    // Consuming again means it must be restored again, or it goes quiet for
    // good behind a connection that reports itself healthy.
    expect(listener.restores).toBe(1);
  });

  it('leaks no handler count when a non-async handler throws synchronously', async () => {
    const conn = new Connection();
    const ch: any = {
        prefetch: async () => undefined,
        consume: async (_q: string, h: any) => { ch._deliver = h; return { consumerTag: 't' }; },
        ack: () => undefined, reject: () => undefined,
        publish: (_e: any, _r: any, _c: any, _o: any, cb: any) => { if (cb) setImmediate(() => cb(null)); return true; },
        sendToQueue: (_q: any, _c: any, _o: any, cb: any) => { if (cb) setImmediate(() => cb(null)); return true; },
        once: () => ch,
    };
    // Not async: it throws before any promise exists to hang cleanup off.
    const handler: any = () => { throw new Error('sync boom'); };
    await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true);
    await ch._deliver({
        content: Buffer.from('x'),
        fields: { routingKey: 'REQUEST.Svc.Api.go', redelivered: false },
        properties: { correlationId: 'c', messageId: 'm', headers: {} },
    });
    expect(conn.inFlightDeliveries).toBe(0);
    expect(await conn.drainInFlight(50)).toBe(true);
  });
});
