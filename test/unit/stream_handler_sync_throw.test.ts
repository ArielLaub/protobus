import MessageService from '../../lib/message_service';
import MessageFactory from '../../lib/message_factory';
import { HandledError } from '../../lib/errors';

/**
 * A streaming handler can fail before it returns its iterable: a plain
 * function validating its arguments, or throwing a HandledError eagerly.
 * That throw escaped dispatch without the reply the connection layer
 * publishes on terminal paths, so the caller heard nothing and sat out its
 * whole idle timeout for a stream that was never going to start (#29).
 *
 * It must be answered exactly as the unary path answers a synchronous throw.
 */

const PROTO = `
syntax = "proto3";
package Feed;
service Ticker {
  rpc validated(Req) returns (stream Tick);
  rpc crashes(Req) returns (stream Tick);
  rpc ticks(Req) returns (stream Tick);
}
message Req { int32 n = 1; }
message Tick { int32 i = 1; }
`;

class Ticker extends MessageService {
    get ServiceName() { return 'Feed.Ticker'; }
    get ProtoFileName() { return 'Feed.proto'; }
    get Proto() { return PROTO; }

    // Not generators: each throws while constructing its iterable.
    validated(req: any): AsyncIterable<any> {
        if (req.n < 1) throw new HandledError('n must be positive', 'INVALID_ARGUMENT');
        return this.ticks(req);
    }

    crashes(): AsyncIterable<any> {
        throw new Error('internal detail: db password rejected');
    }

    async *ticks(req: any) {
        for (let i = 0; i < req.n; i++) yield { i };
    }
}

function build() {
    const factory = new MessageFactory();
    factory.init([]);
    factory.parse(PROTO, 'Feed.Ticker');
    const ctx: any = { factory, connection: { on() {}, removeListener() {} }, publishEvent: async () => undefined };
    return { factory, svc: new Ticker(ctx) };
}

const dispatch = (svc: any, factory: MessageFactory, method: string, n: number) =>
    svc._onMessage(factory.buildRequest(`Feed.Ticker.${method}`, { n }, 'tester'), 'cid', {}, {
        routingKey: `REQUEST.Feed.Ticker.${method}`,
    });

describe('a streaming handler that throws before returning its iterable', () => {
    it('answers a HandledError immediately, as the unary path does', async () => {
        const { factory, svc } = build();
        const out = await dispatch(svc, factory, 'validated', 0);
        expect(Buffer.isBuffer(out)).toBe(true);
        const reply = factory.decodeResponse(out);
        expect(reply.error).toMatchObject({ message: 'n must be positive', code: 'INVALID_ARGUMENT' });
    });

    const crash = async (expose: string) => {
        const previous = process.env.PROTOBUS_EXPOSE_INTERNAL_ERRORS;
        process.env.PROTOBUS_EXPOSE_INTERNAL_ERRORS = expose;
        try {
            const { factory, svc } = build();
            const err = await dispatch(svc, factory, 'crashes', 1).then(
                () => { throw new Error('dispatch should have failed'); },
                (e: any) => e,
            );
            // Thrown, so the connection layer retries and dead-letters it like
            // any unhandled failure, and carries the reply for the terminal path.
            const buffer = err.__PROTOBUS_RESPONSE_BUFFER;
            expect(Buffer.isBuffer(buffer)).toBe(true);
            return factory.decodeResponse(buffer).error!;
        } finally {
            if (previous === undefined) delete process.env.PROTOBUS_EXPOSE_INTERNAL_ERRORS;
            else process.env.PROTOBUS_EXPOSE_INTERNAL_ERRORS = previous;
        }
    };

    it('fails an unexpected error with the reply the connection layer sends on the terminal path', async () => {
        expect((await crash('true')).message).toBe('internal detail: db password rejected');
    });

    it('sanitises that reply when internal errors are not exposed', async () => {
        expect(JSON.stringify(await crash('false'))).not.toContain('db password');
    });

    it('still streams when the handler returns its iterable', async () => {
        const { factory, svc } = build();
        const out = await dispatch(svc, factory, 'validated', 2);
        const frames: any[] = [];
        for await (const frame of out) frames.push(factory.decodeResponse(frame).result!.data);
        expect(frames).toEqual([{ i: 0 }, { i: 1 }]);
    });
});
