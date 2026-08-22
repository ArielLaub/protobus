import ServiceProxy from '../../lib/service_proxy';
import MessageFactory from '../../lib/message_factory';
import {
    UnroutableError, PublishNackedError, PublishConfirmTimeoutError,
    ChannelClosedError, RpcTimeoutError, HandledError,
} from '../../lib/errors';
import { DisconnectedError } from '../../lib/message_dispatcher';

const PROTO = `
syntax = "proto3";
package P;
service S { rpc go(Req) returns (Res); }
message Req { string a = 1; }
message Res { bool ok = 1; }
`;

async function proxyThatFailsWith(thrown: Error) {
    const factory = new MessageFactory();
    factory.init([]);
    factory.parse(PROTO, 'P.S');
    const proxy: any = new ServiceProxy({
        factory,
        publishMessage: async () => { throw thrown; },
    } as any, 'P.S');
    await proxy.init();
    return proxy;
}

describe('ServiceProxy preserves delivery errors', () => {
    const cases: Array<[string, Error]> = [
        ['UnroutableError', new UnroutableError('nothing bound', 'mid-1')],
        ['PublishNackedError', new PublishNackedError('broker refused', 'mid-2')],
        ['PublishConfirmTimeoutError', new PublishConfirmTimeoutError('no confirm', 'mid-3')],
        ['ChannelClosedError', new ChannelClosedError('channel went', 'mid-4')],
        ['RpcTimeoutError', new RpcTimeoutError('no reply')],
        ['DisconnectedError', new DisconnectedError()],
    ];

    it.each(cases)('rethrows %s with its identity intact', async (_name, thrown) => {
        const proxy = await proxyThatFailsWith(thrown);
        await expect(proxy.go({ a: 'x' })).rejects.toBe(thrown);
    });

    it('keeps code and messageId reachable for a dedup decision', async () => {
        const proxy = await proxyThatFailsWith(new PublishConfirmTimeoutError('no confirm', 'mid-9'));
        const caught: any = await proxy.go({ a: 'x' }).catch((e: any) => e);
        expect(caught).toBeInstanceOf(PublishConfirmTimeoutError);
        expect(caught.code).toBe('PUBLISH_CONFIRM_TIMEOUT');
        expect(caught.messageId).toBe('mid-9');
    });

    it('still raises a local encode failure as InvalidRequestError', async () => {
        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(PROTO, 'P.S');
        const proxy: any = new ServiceProxy({
            factory,
            publishMessage: async () => Buffer.alloc(0),
        } as any, 'P.S');
        await proxy.init();
        // An encode failure is local and definite — it never reached the bus,
        // so it stays distinct from the delivery errors above.
        jest.spyOn(factory, 'buildRequest').mockImplementation(() => {
            throw new TypeError('a.length is not a function');
        });
        await expect(proxy.go({ a: 'x' })).rejects.toThrow(/failed parsing message/);
    });

    it('surfaces a remote HandledError with its code', async () => {
        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(PROTO, 'P.S');
        const reply = factory.buildResponse('P.S.go', new HandledError('nope', 'VALIDATION'));
        const proxy: any = new ServiceProxy({
            factory,
            publishMessage: async () => reply,
        } as any, 'P.S');
        await proxy.init();
        const caught: any = await proxy.go({ a: 'x' }).catch((e: any) => e);
        expect(caught.message).toBe('nope');
        expect(caught.code).toBe('VALIDATION');
    });
});
