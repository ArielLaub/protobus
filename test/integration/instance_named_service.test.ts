import * as amqplib from 'amqplib';
import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';

/**
 * Several instances of one contract, each addressed by its own name, reached
 * through an ordinary typed proxy.
 *
 * `MessageService` has always supported this: `Combat.Player.player6` serves
 * the contract `Combat.Player`, resolved by trimming trailing segments.
 * `ServiceProxy` did not, so the only way to call one instance was to build
 * the routing key by hand. The round trip is the thing worth asserting —
 * the routing key has to reach the right instance AND the envelope has to
 * satisfy the receiving service's method validation, and only one of the two
 * is visible from either end alone.
 */

const proto = `syntax = "proto3";
package Combat;

message ShootRequest { string target = 1; }
message ShootResponse { string shooter = 1; }

service Player {
    rpc shoot(Combat.ShootRequest) returns(Combat.ShootResponse);
}`;

const AMQP = 'amqp://guest:guest@localhost:5672/';
const RUN = Date.now();
const PLAYER_SIX = `Combat.Player.player6_${RUN}`;
const PLAYER_SEVEN = `Combat.Player.player7_${RUN}`;

class Player extends MessageService {
    constructor(context: IContext, private readonly instanceName: string) { super(context); }
    public get ServiceName(): string { return this.instanceName; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }

    public async shoot(request: any): Promise<any> {
        return { shooter: `${this.instanceName} shot ${request.target}` };
    }
}

describe('proxying an instance-named service', () => {
    let context: Context;
    let six: any;
    let seven: any;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP, []);
        context.factory.parse(proto, 'Combat.Player');

        await new Player(context, PLAYER_SIX).init();
        await new Player(context, PLAYER_SEVEN).init();

        six = new ServiceProxy(context, PLAYER_SIX);
        await six.init();
        seven = new ServiceProxy(context, PLAYER_SEVEN);
        await seven.init();
    }, 30000);

    afterAll(async () => {
        try {
            const raw = await amqplib.connect(AMQP);
            const ch = await raw.createChannel();
            for (const name of [PLAYER_SIX, PLAYER_SEVEN]) {
                for (const q of [name, `${name}.DLQ`, `${name}.Retry`, `${name}.Events`]) {
                    await ch.deleteQueue(q).catch(() => undefined);
                }
                await ch.deleteExchange(`${name}.Retry.Exchange`).catch(() => undefined);
            }
            await ch.close();
            await raw.close();
        } catch { /* best effort */ }
        if (context && context.isConnected) { await context.connection.disconnect(); }
    }, 30000);

    it('reaches the instance the proxy names', async () => {
        const result = await six.shoot({ target: 'someone' });
        expect(result.shooter).toBe(`${PLAYER_SIX} shot someone`);
    });

    it('reaches a DIFFERENT instance of the same contract', async () => {
        // Both services share one schema and one contract, so this is the
        // assertion that the routing key — not the contract name — is what
        // selects the instance.
        const result = await seven.shoot({ target: 'someone else' });
        expect(result.shooter).toBe(`${PLAYER_SEVEN} shot someone else`);
    });

    it('satisfies the receiving service method validation', async () => {
        // MessageService rejects a request whose envelope method is not a
        // method of its contract, and rejects one whose method contradicts the
        // routing key. A reply proves both checks passed on the real path.
        const result = await six.shoot({ target: 'validation' });
        expect(result).toMatchObject({ shooter: expect.stringContaining('validation') });
    });
});
