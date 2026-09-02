import { EventEmitter } from 'events';
import MessageDispatcher from '../../lib/message_dispatcher';
import Connection from '../../lib/connection';
import { InvalidPriorityError } from '../../lib/priority';
import Config from '../../lib/config';

/**
 * A caller must be able to set the `messageId` of a publish.
 *
 * The package root and the 2.0 changelog both tell a caller to deduplicate on
 * `messageId` after an ambiguous publish outcome — a confirm timeout or a
 * channel close, where the broker may or may not have stored the message. But
 * a republish minted a *fresh* UUID, so the second copy was unrecognisable as
 * the same logical message and the documented recovery was impossible to
 * carry out. The connection layer has always honoured a caller-supplied
 * `properties.messageId`; there was simply no public way to supply one.
 */

function fakeConnection(published: any[]) {
    return Object.assign(new EventEmitter(), {
        isConnected: true,
        isReconnecting: false,
        whenReady: async () => undefined,
        openChannel: async () => ({}),
        closeChannel: async () => undefined,
        declareExchange: async () => undefined,
        declareQueue: async (_c: any, n: string) => n || 'q',
        bindQueue: async () => undefined,
        consume: async () => ({ consumerTag: 't' }),
        cancel: async () => undefined,
        registerRestorer: () => () => undefined,
        publish: async (_ch: any, exchange: string, routingKey: string, _c: Buffer, props: any) => {
            published.push({ exchange, routingKey, props });
        },
    }) as any;
}

async function dispatcherWith(published: any[]) {
    const dispatcher = new MessageDispatcher(fakeConnection(published));
    // init() would build a callback listener against a real channel; the
    // publish path only needs the channel and the initialised flag.
    (dispatcher as any).channel = {};
    (dispatcher as any)._isInitialized = true;
    (dispatcher as any).callbackListener = { callbackQueue: 'amq.gen-cb' };
    return dispatcher;
}

describe('CallOptions.messageId', () => {
    it('puts the caller supplied id on the published message', async () => {
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);

        await dispatcher.publish(
            Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined,
            { messageId: 'order-4711-attempt-1' },
        );

        expect(published).toHaveLength(1);
        expect(published[0].props.messageId).toBe('order-4711-attempt-1');
    });

    it('lets a republish after an ambiguous outcome reuse the same id', async () => {
        // The documented recovery: the caller cannot tell whether the first
        // publish was stored, republishes under the SAME id, and the consumer
        // recognises the two copies as one message.
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);
        const id = 'order-4711';

        await dispatcher.publish(Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined, { messageId: id });
        await dispatcher.publish(Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined, { messageId: id });

        expect(published.map((p: any) => p.props.messageId)).toEqual([id, id]);
    });

    it('sets no messageId property when the caller supplies none', async () => {
        // The dispatcher must leave the property ABSENT rather than setting
        // undefined or a constant, because the connection layer's
        // `properties.messageId || randomUUID()` is what mints the default and
        // it only runs when nothing is there. The minting itself is asserted
        // against the real publish path below, not against this fake.
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);

        await dispatcher.publish(Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false);

        expect(Object.prototype.hasOwnProperty.call(published[0].props, 'messageId')).toBe(false);
    });

    it('the connection layer mints a distinct id per publish when none is given', async () => {
        // The real minting path, driven through Connection.publish with a fake
        // channel, so the documented default is actually exercised somewhere.
        const conn = new Connection();
        const seen: any[] = [];
        const channel: any = {
            publish(_e: string, _rk: string, _c: Buffer, options: any, cb?: any) {
                seen.push(options);
                if (cb) { setImmediate(() => cb(null)); }
                return true;
            },
            once() { return this; },
        };

        await conn.publish(channel, 'proto.bus', 'REQUEST.Svc.Api.doThing', Buffer.from('a'), {});
        await conn.publish(channel, 'proto.bus', 'REQUEST.Svc.Api.doThing', Buffer.from('b'), {});

        expect(typeof seen[0].messageId).toBe('string');
        expect(seen[0].messageId).not.toBe(seen[1].messageId);
    });

    it('the connection layer keeps a caller supplied id instead of minting', async () => {
        const conn = new Connection();
        const seen: any[] = [];
        const channel: any = {
            publish(_e: string, _rk: string, _c: Buffer, options: any, cb?: any) {
                seen.push(options);
                if (cb) { setImmediate(() => cb(null)); }
                return true;
            },
            once() { return this; },
        };

        await conn.publish(
            channel, 'proto.bus', 'REQUEST.Svc.Api.doThing', Buffer.from('a'),
            { messageId: 'caller-chosen' } as any,
        );

        expect(seen[0].messageId).toBe('caller-chosen');
    });

    it('refuses an empty id rather than silently minting a UUID instead', async () => {
        // `properties.messageId || randomUUID()` treats '' as absent. A caller
        // who derived an id from a field that turned out to be empty would get
        // a fresh UUID per attempt and no deduplication at all — the exact
        // failure the option exists to prevent, arriving silently.
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);

        await expect(dispatcher.publish(
            Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined, { messageId: '  ' },
        )).rejects.toThrow(/messageId/);
        expect(published).toHaveLength(0);
    });

    it('leaves priority validation alone', async () => {
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);
        await expect(dispatcher.publish(
            Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined,
            { priority: 999, messageId: 'x' } as any,
        )).rejects.toThrow(InvalidPriorityError);
        expect(Config.PRIORITY_NORMAL).toBe(0);
    });
});

/**
 * AMQP carries `message-id` as a shortstr, so amqplib refuses anything over
 * 255 bytes with `TypeError: Field 'messageId' is the wrong type; must be a
 * string (up to 255 chars)` — raised deep inside the publish path and reported
 * as an opaque TypeError. The whole point of validating here is that a bad
 * caller-derived id fails at the API boundary with a typed error, and an id
 * built by concatenating request fields or base64-ing a hash goes over 255
 * easily.
 */
describe('CallOptions.messageId length', () => {
    it('refuses an id longer than the AMQP shortstr limit', async () => {
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);

        await expect(dispatcher.publish(
            Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined,
            { messageId: 'x'.repeat(256) },
        )).rejects.toThrow(/255/);
        expect(published).toHaveLength(0);
    });

    it('measures the limit in BYTES, not characters', async () => {
        // 200 Hebrew characters are 400 bytes on the wire. Counting characters
        // would let this through to fail at the broker instead.
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);

        await expect(dispatcher.publish(
            Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined,
            { messageId: 'ש'.repeat(200) },
        )).rejects.toThrow(/255/);
    });

    it('accepts an id exactly at the limit', async () => {
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);
        const id = 'x'.repeat(255);

        await dispatcher.publish(Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false, undefined, { messageId: id });
        expect(published[0].props.messageId).toBe(id);
    });
});
