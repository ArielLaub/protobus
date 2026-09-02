import { EventEmitter } from 'events';
import MessageDispatcher from '../../lib/message_dispatcher';
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

    it('still mints a fresh id when the caller supplies none', async () => {
        const published: any[] = [];
        const dispatcher = await dispatcherWith(published);

        await dispatcher.publish(Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false);
        await dispatcher.publish(Buffer.from('body'), 'REQUEST.Svc.Api.doThing', false);

        // Minted by the connection layer, which this fake stands in for, so
        // the property is simply absent here — the point is that nothing is
        // pinned to a constant.
        expect(published[0].props.messageId).toBeUndefined();
        expect(published[1].props.messageId).toBeUndefined();
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
