import ServiceProxy, { InvalidServiceNameError } from '../../lib/service_proxy';
import MessageFactory from '../../lib/message_factory';
import { IContext } from '../../lib/context';

/**
 * A ServiceProxy must be able to address an instance-named service.
 *
 * `MessageService` resolves its `ServiceName` against the schema by trimming
 * trailing segments — several instances share one contract, and
 * `Combat.Player.player6` serves the contract `Combat.Player`. `ServiceProxy`
 * looked the name up verbatim, so the only way to reach one instance was to
 * build the routing key by hand and call `context.publishMessage` directly,
 * giving up the typed proxy entirely.
 *
 * The two names play different parts, which is why one string could not serve
 * both: the ROUTING KEY must carry the runtime name, so the broker reaches
 * this instance's queue, while the request envelope must carry the CONTRACT
 * method name, because that is what the receiving MessageService validates the
 * body against.
 */

const proto = `syntax = "proto3";
package Combat;

message ShootRequest { string target = 1; }
message ShootResponse { bool hit = 1; }

service Player {
    rpc shoot(Combat.ShootRequest) returns(Combat.ShootResponse);
}`;

interface Published { routingKey: string; content: Buffer }

function contextWith(published: Published[]): IContext {
    const factory = new MessageFactory();
    factory.init([]);
    factory.parse(proto, 'Combat.Player');
    return {
        factory,
        connection: {} as any,
        isConnected: true,
        isReconnecting: false,
        init: async () => undefined,
        publishEvent: async () => undefined,
        publishStreamingMessage: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) } as any),
        publishMessage: async (content: any, routingKey: string) => {
            published.push({ routingKey, content });
            // The proxy decodes whatever comes back; a valid empty response is
            // enough for a routing assertion.
            return factory.buildResponse('Combat.Player.shoot', { hit: true });
        },
    } as any;
}

describe('ServiceProxy against an instance-named service', () => {
    it('initialises against the contract the runtime name is an instance of', async () => {
        const proxy = new ServiceProxy(contextWith([]), 'Combat.Player.player6');
        await expect(proxy.init()).resolves.toBeUndefined();
        expect(typeof (proxy as any).shoot).toBe('function');
    });

    it('routes to the INSTANCE, not to the contract', async () => {
        const published: Published[] = [];
        const proxy: any = new ServiceProxy(contextWith(published), 'Combat.Player.player6');
        await proxy.init();

        await proxy.shoot({ target: 'player7' });

        expect(published).toHaveLength(1);
        expect(published[0].routingKey).toBe('REQUEST.Combat.Player.player6.shoot');
    });

    it('names the CONTRACT method in the envelope, which is what the server validates', async () => {
        const published: Published[] = [];
        const context = contextWith(published);
        const proxy: any = new ServiceProxy(context, 'Combat.Player.player6');
        await proxy.init();

        await proxy.shoot({ target: 'player7' });

        const envelope = context.factory.decodeRequestEnvelope(published[0].content);
        expect(envelope.method).toBe('Combat.Player.shoot');
        expect(context.factory.decodeRequestPayload(envelope.method, envelope.data as any))
            .toMatchObject({ target: 'player7' });
    });

    it('still works for a plain contract name', async () => {
        const published: Published[] = [];
        const context = contextWith(published);
        const proxy: any = new ServiceProxy(context, 'Combat.Player');
        await proxy.init();

        await proxy.shoot({ target: 'player7' });

        expect(published[0].routingKey).toBe('REQUEST.Combat.Player.shoot');
        expect(context.factory.decodeRequestEnvelope(published[0].content).method)
            .toBe('Combat.Player.shoot');
    });

    it('still refuses a name that matches no contract at any prefix', async () => {
        const proxy = new ServiceProxy(contextWith([]), 'Combat.Referee.ref1');
        await expect(proxy.init()).rejects.toThrow(InvalidServiceNameError);
    });
});
