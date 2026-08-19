import * as protoBuf from 'protobufjs';
import MessageService from '../../lib/message_service';
import MessageFactory from '../../lib/message_factory';

const TARGET = `
syntax = "proto3";
package Combat;
service Player {
  rpc shoot(ShootRequest) returns (ShootResponse);
  rpc stopConsuming(ShootRequest) returns (ShootResponse);
}
message ShootRequest { string target = 1; }
message ShootResponse { bool hit = 1; }
`;

const OTHER = `
syntax = "proto3";
package Other;
service Service {
  rpc shoot(OtherShoot) returns (OtherResponse);
}
message OtherShoot { string attacker_field = 1; int32 privileged = 2; }
message OtherResponse { bool ok = 1; }
`;

class Player extends MessageService {
    public shots: any[] = [];
    public playerId = 'player6';
    get ServiceName() { return `Combat.Player.${this.playerId}`; }
    get ProtoFileName() { return 'Combat.proto'; }
    get Proto() { return TARGET; }
    async shoot(req: any) { this.shots.push(req); return { hit: true }; }
    // `stopConsuming` is declared in the .proto above but deliberately NOT
    // implemented here: it must not fall through to the framework's member.
}

/** Re-encode a RequestContainer with an attacker-chosen `method`. */
function forge(factory: MessageFactory, realMethod: string, forgedMethod: string, obj: any): Buffer {
    const real = factory.buildRequest(realMethod, obj, 'attacker');
    const r = protoBuf.Reader.create(real);
    let data: Buffer | undefined; let actor = '';
    while (r.pos < r.len) {
        const tag = r.uint32();
        switch (tag >>> 3) {
            case 1: r.string(); break;
            case 2: actor = r.string(); break;
            case 3: data = Buffer.from(r.bytes()); break;
            default: r.skipType(tag & 7);
        }
    }
    const w = protoBuf.Writer.create();
    w.uint32(10).string(forgedMethod);
    w.uint32(18).string(actor);
    w.uint32(26).bytes(data!);
    return Buffer.from(w.finish());
}

function build() {
    const factory = new MessageFactory();
    factory.init([]);
    factory.parse(TARGET, 'Combat.Player');
    factory.parse(OTHER, 'Other.Service');
    const published: any[] = [];
    const ctx: any = {
        factory,
        connection: { on() {}, removeListener() {} },
        publishEvent: (...a: any[]) => { published.push(a); return Promise.resolve(); },
    };
    return { factory, svc: new Player(ctx), published };
}

/** Decode whatever _onMessage produced, so we can assert on the error reply. */
function replyOf(factory: MessageFactory, buf: any) {
    return factory.decodeResponse(buf);
}

describe('request dispatch is bound to the service contract', () => {
    it('serves a legitimate call under a runtime name that differs from the contract', async () => {
        const { factory, svc } = build();
        const body = factory.buildRequest('Combat.Player.shoot', { target: 'bob' }, 'alice');
        const out = await (svc as any)._onMessage(body, 'cid', {}, {
            routingKey: 'REQUEST.Combat.Player.player6.shoot',
        });
        expect(svc.shots).toEqual([{ target: 'bob' }]);
        expect(replyOf(factory, out).result!.data).toMatchObject({ hit: true });
    });

    it('rejects a trailing segment that renames the dispatch target', async () => {
        const { factory, svc, published } = build();
        const body = forge(factory, 'Combat.Player.shoot', 'Combat.Player.shoot.publishEvent',
            { target: 'bob' });
        const out = await (svc as any)._onMessage(body, 'cid', {}, {
            routingKey: 'REQUEST.Combat.Player.player6.publishEvent',
        }).catch((e: any) => e);
        expect(published).toHaveLength(0);
        expect(replyOf(factory, out).error).toBeTruthy();
    });

    it('rejects a body whose method belongs to another service', async () => {
        const { factory, svc } = build();
        const body = forge(factory, 'Other.Service.shoot', 'Other.Service.shoot',
            { attacker_field: 'pwn', privileged: 7 });
        const out = await (svc as any)._onMessage(body, 'cid', {}, {
            routingKey: 'REQUEST.Combat.Player.player6.shoot',
        }).catch((e: any) => e);
        expect(svc.shots).toHaveLength(0);
        expect(replyOf(factory, out).error).toBeTruthy();
    });

    it('does not fall through to a framework member for a declared but unimplemented rpc', async () => {
        const { factory, svc } = build();
        const stop = jest.spyOn(MessageService.prototype, 'stopConsuming');
        const body = factory.buildRequest('Combat.Player.stopConsuming', { target: 'x' }, 'attacker');
        const out = await (svc as any)._onMessage(body, 'cid', {}, {
            routingKey: 'REQUEST.Combat.Player.player6.stopConsuming',
        }).catch((e: any) => e);
        expect(stop).not.toHaveBeenCalled();
        expect(replyOf(factory, out).error).toBeTruthy();
        stop.mockRestore();
    });

    it('rejects a mismatch between the routing key and the body method', async () => {
        const { factory, svc } = build();
        const body = factory.buildRequest('Combat.Player.shoot', { target: 'bob' }, 'alice');
        const out = await (svc as any)._onMessage(body, 'cid', {}, {
            routingKey: 'REQUEST.Combat.Player.player6.stopConsuming',
        }).catch((e: any) => e);
        expect(svc.shots).toHaveLength(0);
        expect(replyOf(factory, out).error).toBeTruthy();
    });

    it('still validates the body when no routing key is available', async () => {
        const { factory, svc, published } = build();
        const body = forge(factory, 'Combat.Player.shoot', 'Combat.Player.shoot.publishEvent',
            { target: 'bob' });
        const out = await (svc as any)._onMessage(body, 'cid', {}, undefined).catch((e: any) => e);
        expect(published).toHaveLength(0);
        expect(replyOf(factory, out).error).toBeTruthy();
    });
});
