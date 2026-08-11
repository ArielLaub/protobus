import { EventEmitter } from 'events';
import * as amqplib from 'amqplib';

import Connection from '../../lib/connection';
import {
    PublishNackedError,
    UnroutableError,
    PublishConfirmTimeoutError,
    ChannelClosedError,
} from '../../lib/errors';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * The audit's headline P0: `await publish()` resolved as soon as amqplib
 * accepted the bytes into its local write buffer, which says nothing about
 * whether RabbitMQ ever received the message. These tests pin the contract
 * that a resolved publish means a positive broker confirm, and that every
 * other outcome is a distinct, typed rejection.
 */

/** A fake amqplib ConfirmChannel with manually-driven confirm callbacks. */
class FakeConfirmChannel extends EventEmitter {
    public published: Array<{
        exchange: string;
        routingKey: string;
        content: Buffer;
        options: any;
        callback: (err: Error | null) => void;
    }> = [];
    /** When false, publish() reports a full write buffer, as amqplib does. */
    public writable = true;

    publish(exchange: string, routingKey: string, content: Buffer, options: any, callback: any) {
        this.published.push({ exchange, routingKey, content, options, callback });
        return this.writable;
    }
    sendToQueue(_queue: string, content: Buffer, options: any, callback: any) {
        this.published.push({ exchange: '', routingKey: _queue, content, options, callback });
        return this.writable;
    }
    async close() { return undefined; }

    /** Broker acked message `i`. */
    confirm(i = 0) { this.published[i].callback(null); }
    /** Broker nacked message `i`. */
    nack(i = 0) { this.published[i].callback(new Error('NACK')); }
    /** Broker returned message `i` as unroutable, then confirmed it. */
    returnUnroutable(i = 0) {
        const m = this.published[i];
        // RabbitMQ always sends basic.return BEFORE the confirm for that message.
        this.emit('return', { properties: { messageId: m.options.messageId }, fields: {} });
        m.callback(null);
    }
    emitDrain() { this.emit('drain'); }
}

function connectionWith(channel: FakeConfirmChannel) {
    const handle = Object.assign(new EventEmitter(), {
        createConfirmChannel: jest.fn(async () => channel),
        createChannel: jest.fn(async () => channel),
        close: jest.fn(async () => undefined),
    });
    (amqplib.connect as jest.Mock).mockResolvedValue(handle);
    return handle;
}

/** Has the promise settled yet? Lets us assert "still pending". */
function track(p: Promise<any>) {
    const state = { settled: false, rejected: false, error: undefined as any };
    p.then(
        () => { state.settled = true; },
        (e) => { state.settled = true; state.rejected = true; state.error = e; },
    );
    return state;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('publisher confirms', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.clearAllMocks();
    });

    it('opens a confirm channel rather than a plain one', async () => {
        const ch = new FakeConfirmChannel();
        const handle = connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://guest:guest@localhost:5672/');

        await conn.openChannel();

        // A plain channel has no confirm mechanism at all, so nothing below
        // this line is achievable without it.
        expect(handle.createConfirmChannel).toHaveBeenCalled();
        expect(handle.createChannel).not.toHaveBeenCalled();
    });

    it('does not resolve until the broker confirms', async () => {
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const state = track(conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {}));
        await tick();

        // The bytes are in amqplib's buffer, but RabbitMQ has said nothing.
        expect(ch.published).toHaveLength(1);
        expect(state.settled).toBe(false);

        ch.confirm();
        await tick();
        expect(state.settled).toBe(true);
        expect(state.rejected).toBe(false);
    });

    it('rejects with PublishNackedError when the broker nacks', async () => {
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const p = conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {});
        await tick();
        ch.nack();

        await expect(p).rejects.toBeInstanceOf(PublishNackedError);
    });

    it('rejects with UnroutableError when a mandatory message is returned', async () => {
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const p = conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), { mandatory: true });
        await tick();
        ch.returnUnroutable();

        // The broker ACKs an unroutable mandatory message after returning it,
        // so confirm-only handling would report success for a message that
        // reached no queue at all.
        await expect(p).rejects.toBeInstanceOf(UnroutableError);
    });

    it('stamps a messageId so returns can be correlated', async () => {
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const p = conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), { mandatory: true });
        await tick();
        expect(typeof ch.published[0].options.messageId).toBe('string');
        expect(ch.published[0].options.messageId.length).toBeGreaterThan(0);
        ch.confirm();
        await p;
    });

    it('preserves a caller-supplied messageId', async () => {
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const p = conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), { messageId: 'stable-id' });
        await tick();
        // Retries must keep the same identity for idempotent consumers.
        expect(ch.published[0].options.messageId).toBe('stable-id');
        ch.confirm();
        await p;
    });

    it('rejects with PublishConfirmTimeoutError when no confirm arrives', async () => {
        process.env.PUBLISH_CONFIRM_TIMEOUT_MS = '40';
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        // A broker that accepts bytes and then goes silent must not park the
        // caller forever.
        await expect(
            conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {}),
        ).rejects.toBeInstanceOf(PublishConfirmTimeoutError);
    });

    it('rejects outstanding publishes when the channel closes', async () => {
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const p = conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {});
        await tick();
        ch.emit('close');

        // Outcome is unknown, not success: the caller must find out.
        await expect(p).rejects.toBeInstanceOf(ChannelClosedError);
    });

    it('bounds the number of unconfirmed publishes in flight', async () => {
        process.env.MAX_OUTSTANDING_CONFIRMS = '2';
        const ch = new FakeConfirmChannel();
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const a = track(conn.publish(ch as any, 'ex', 'rk', Buffer.from('a'), {}));
        const b = track(conn.publish(ch as any, 'ex', 'rk', Buffer.from('b'), {}));
        const c = track(conn.publish(ch as any, 'ex', 'rk', Buffer.from('c'), {}));
        await tick();

        // The third must not even reach the channel until one slot frees.
        expect(ch.published).toHaveLength(2);
        expect(c.settled).toBe(false);

        ch.confirm(0);
        await tick();
        expect(ch.published).toHaveLength(3);

        ch.confirm(1);
        ch.confirm(2);
        await tick();
        expect(a.settled && b.settled && c.settled).toBe(true);
    });

    it('still applies write-buffer backpressure', async () => {
        const ch = new FakeConfirmChannel();
        ch.writable = false;
        connectionWith(ch);
        const conn = new Connection();
        await conn.connect('amqp://localhost');

        const state = track(conn.publish(ch as any, 'ex', 'rk', Buffer.from('x'), {}));
        await tick();

        // Confirmed but the socket buffer is still full: the publish must not
        // resolve and invite the caller to send more.
        ch.confirm();
        await tick();
        expect(state.settled).toBe(false);

        ch.emitDrain();
        await tick();
        expect(state.settled).toBe(true);
    });
});
