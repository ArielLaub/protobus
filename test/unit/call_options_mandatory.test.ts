import { EventEmitter } from 'events';
import MessageDispatcher from '../../lib/message_dispatcher';
import Connection from '../../lib/connection';
import { UnroutableError } from '../../lib/errors';

/**
 * A fire-and-forget publish (`rpc === false`) can ask to be `mandatory`.
 *
 * RPC requests are always mandatory, so a request that routes nowhere fails
 * fast as UnroutableError. A fire-and-forget publish was not, because it shares
 * the event rule: no subscriber is normal. That is right for an event and wrong
 * for a COMMAND sent without waiting for its reply — "recalculate this user",
 * "send this email". With the target queue absent the broker dropped the
 * command and still confirmed it, so the publisher resolved, recorded success,
 * and nothing ever retried. `CallOptions.mandatory` lets that caller say "this
 * must reach a queue", and get UnroutableError when it does not.
 */

const KEY = 'REQUEST.Svc.Api.doThing';

function fakeConnection(published: any[]) {
    return Object.assign(new EventEmitter(), {
        isConnected: true,
        isReconnecting: false,
        whenReady: async () => undefined,
        openChannel: async () => ({}),
        publish: async (_ch: any, exchange: string, routingKey: string, _c: Buffer, props: any) => {
            published.push({ exchange, routingKey, props });
        },
    }) as any;
}

function dispatcherOn(connection: any) {
    const dispatcher = new MessageDispatcher(connection);
    (dispatcher as any)._isInitialized = true;
    (dispatcher as any).callbackListener = { callbackQueue: 'amq.gen-cb' };
    return dispatcher;
}

describe('CallOptions.mandatory', () => {
    it('publishes a fire-and-forget call mandatory when asked', async () => {
        const published: any[] = [];
        const dispatcher = dispatcherOn(fakeConnection(published));
        (dispatcher as any).channel = {};

        await dispatcher.publish(Buffer.from('body'), KEY, false, undefined, { mandatory: true });

        expect(published[0].props.mandatory).toBe(true);
    });

    it('leaves a fire-and-forget call non-mandatory by default, and when false', async () => {
        const published: any[] = [];
        const dispatcher = dispatcherOn(fakeConnection(published));
        (dispatcher as any).channel = {};

        await dispatcher.publish(Buffer.from('body'), KEY, false);
        await dispatcher.publish(Buffer.from('body'), KEY, false, undefined, {});
        await dispatcher.publish(Buffer.from('body'), KEY, false, undefined, { mandatory: false });

        expect(published.map((p) => p.props.mandatory)).toEqual([false, false, false]);
    });

    it('cannot make an RPC non-mandatory', async () => {
        const published: any[] = [];
        const dispatcher = dispatcherOn(fakeConnection(published));
        (dispatcher as any).channel = {};

        const reply = dispatcher.publish(Buffer.from('body'), KEY, true, 50, { mandatory: false });
        reply.catch(() => undefined);
        await new Promise((resolve) => setImmediate(resolve));

        expect(published[0].props.mandatory).toBe(true);
        await expect(reply).rejects.toThrow();
    });

    /**
     * End to end through the real Connection.publish: a fake channel that
     * routes like RabbitMQ — a mandatory message matching no queue is returned
     * (basic.return before the confirm), a non-mandatory one is dropped and
     * confirmed all the same.
     */
    describe('against the real publish path, with no queue bound', () => {
        function routingNowhere() {
            const connection = new Connection();
            const dropped: string[] = [];
            const channel = Object.assign(new EventEmitter(), {
                publish(_exchange: string, routingKey: string, content: Buffer, props: any, onConfirm: (err: any) => void) {
                    setImmediate(() => {
                        if (props.mandatory) {
                            channel.emit('return', { fields: { routingKey }, properties: props, content });
                        } else {
                            dropped.push(routingKey);
                        }
                        onConfirm(null);
                    });
                    return true;
                },
            });
            Object.assign(connection as any, { _isConnected: true, _isReady: true });
            const dispatcher = dispatcherOn(connection);
            (dispatcher as any).channel = channel;
            return { dispatcher, dropped };
        }

        it('rejects a mandatory fire-and-forget with UnroutableError', async () => {
            const { dispatcher, dropped } = routingNowhere();

            await expect(
                dispatcher.publish(Buffer.from('body'), KEY, false, undefined, { mandatory: true }),
            ).rejects.toBeInstanceOf(UnroutableError);
            expect(dropped).toEqual([]);
        });

        it('still resolves a plain fire-and-forget, which the broker silently drops', async () => {
            const { dispatcher, dropped } = routingNowhere();

            await expect(dispatcher.publish(Buffer.from('body'), KEY, false)).resolves.toBeUndefined();
            expect(dropped).toEqual([KEY]);
        });
    });
});
