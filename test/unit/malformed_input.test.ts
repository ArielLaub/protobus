import MessageService, { InvalidMethodError } from '../../lib/message_service';
import MessageFactory from '../../lib/message_factory';
import { isHandledError } from '../../lib/errors';

const PROTO = `
syntax = "proto3";
package Combat;
service Player { rpc shoot(ShootRequest) returns (ShootResponse); }
message ShootRequest { string target = 1; }
message ShootResponse { bool hit = 1; }
`;

class Player extends MessageService {
    get ServiceName() { return 'Combat.Player'; }
    get ProtoFileName() { return 'Combat.proto'; }
    get Proto() { return PROTO; }
    async shoot() { return { hit: true }; }
}

function build() {
    const factory = new MessageFactory();
    factory.init([]);
    factory.parse(PROTO, 'Combat.Player');
    return {
        factory,
        svc: new Player({ factory, connection: { on() {}, removeListener() {} } } as any),
    };
}

const RK = { routingKey: 'REQUEST.Combat.Player.shoot' };

describe('undecodable input is answered, not retried', () => {
    it('replies with a protocol error instead of throwing', async () => {
        const { factory, svc } = build();
        const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
        const out = await (svc as any)._onMessage(garbage, 'cid', {}, RK);
        const reply = factory.decodeResponse(out);
        expect(reply.error).toBeTruthy();
        expect(reply.error!.code).toBe('PROTOCOL_ERROR');
    });

    it('classifies the failure as handled, so the retry ladder is skipped', async () => {
        const { svc } = build();
        let thrown: any;
        await (svc as any)._onMessage(Buffer.from([0xff, 0xff]), 'cid', {}, RK)
            .catch((e: any) => { thrown = e; });
        expect(thrown).toBeUndefined();
    });

    it('answers an undecodable payload behind a valid envelope', async () => {
        const { factory, svc } = build();
        const protoBuf = require('protobufjs');
        const w = protoBuf.Writer.create();
        w.uint32(10).string('Combat.Player.shoot');
        w.uint32(18).string('attacker');
        w.uint32(26).bytes(Buffer.from([0xff, 0xff, 0xff]));
        const out = await (svc as any)._onMessage(Buffer.from(w.finish()), 'cid', {}, RK);
        expect(factory.decodeResponse(out).error!.code).toBe('PROTOCOL_ERROR');
    });

    it('still treats a real handler failure as retryable', async () => {
        const { factory, svc } = build();
        (svc as any).shoot = async () => { throw new Error('database is down'); };
        const body = factory.buildRequest('Combat.Player.shoot', { target: 'x' }, 'a');
        let thrown: any;
        await (svc as any)._onMessage(body, 'cid', {}, RK).catch((e: any) => { thrown = e; });
        expect(thrown).toBeInstanceOf(Error);
        expect(isHandledError(thrown)).toBe(false);
    });

    it('keeps InvalidMethodError out of the retry ladder too', async () => {
        expect(isHandledError(new InvalidMethodError('nope'))).toBe(true);
    });
});
