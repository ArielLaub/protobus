import { EventEmitter } from 'events';
import Connection, { MessageHandler } from '../../lib/connection';

class FakeChannel {
    public acked: any[] = [];
    private onMessage: ((msg: any) => Promise<void>) | undefined;
    async prefetch() { return undefined; }
    async consume(_q: string, handler: (msg: any) => Promise<void>) {
        this.onMessage = handler;
        return { consumerTag: 'tag' };
    }
    ack(msg: any) { this.acked.push(msg); }
    reject() { /* unused */ }
    publish(_e: string, _r: string, _c: Buffer, _o: any, cb?: any) { if (cb) setImmediate(() => cb(null)); return true; }
    sendToQueue(_q: string, _c: Buffer, _o: any, cb?: any) { if (cb) setImmediate(() => cb(null)); return true; }
    once() { return this; }
    deliver(msg: any) { return this.onMessage ? this.onMessage(msg) : Promise.resolve(); }
}

const message = () => ({
    content: Buffer.from('x'),
    fields: { routingKey: 'REQUEST.Svc.Api.doThing', redelivered: false },
    properties: { correlationId: 'cid', messageId: 'mid', headers: {} },
});

describe('drain waits for handlers, not just deliveries', () => {
    it('does not report drained while a timed-out handler is still running', async () => {
        const conn = new Connection();
        const ch = new FakeChannel();

        let releaseHandler!: () => void;
        let handlerDone = false;
        const handler: MessageHandler = () => new Promise((resolve) => {
            releaseHandler = () => { handlerDone = true; resolve(undefined); };
        });

        // 20ms processing timeout: the delivery is abandoned long before the
        // handler, which ignores its signal, finishes.
        await conn.consume(ch as any, 'Svc', handler, { noAck: false } as any, true, undefined, 20);
        void ch.deliver(message());

        await new Promise((r) => setTimeout(r, 120));

        // The delivery has been settled and rejected by now...
        const drained = await conn.drainInFlight(80);
        expect(handlerDone).toBe(false);
        // ...but the handler has not returned, so a drain must not claim it has.
        expect(drained).toBe(false);

        releaseHandler();
        expect(await conn.drainInFlight(1000)).toBe(true);
    });
});

describe('publish bookkeeping survives a channel teardown', () => {
    it('does not drive the outstanding-confirm counter negative', async () => {
        const conn: any = new Connection();
        const ch: any = new EventEmitter();
        ch.publish = () => true; // never confirms
        const state = conn._publishStateFor(ch);

        const p1 = conn.publish(ch, 'ex', 'rk', Buffer.alloc(1), {}).catch(() => undefined);
        const p2 = conn.publish(ch, 'ex', 'rk', Buffer.alloc(1), {}).catch(() => undefined);
        await new Promise((r) => setImmediate(r));
        expect(state.inFlight).toBe(2);

        ch.emit('close');
        await Promise.all([p1, p2]);
        expect(state.inFlight).toBe(0);
    });

    it('does not let a stale return fail a later publish reusing the messageId', async () => {
        const conn: any = new Connection();
        const ch: any = new EventEmitter();
        let confirm: ((err: any) => void) | undefined;
        ch.publish = (_e: string, _r: string, _c: Buffer, _p: any, cb: any) => { confirm = cb; return true; };
        conn._publishStateFor(ch);

        // A return that arrives with no publish waiting on it — the owning
        // publish already gave up — must not be held against the next one.
        ch.emit('return', { properties: { messageId: 'stable-1' } });

        const p = conn.publish(ch, 'ex', 'rk', Buffer.alloc(1), { messageId: 'stable-1' });
        await new Promise((r) => setImmediate(r));
        confirm!(null);
        await expect(p).resolves.toBeUndefined();
    });
});
