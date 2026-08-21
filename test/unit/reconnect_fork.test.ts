import { EventEmitter } from 'events';
import * as amqplib from 'amqplib';
import Connection from '../../lib/connection';
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
