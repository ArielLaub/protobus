import Config from '../../lib/config';
import MessageFactory from '../../lib/message_factory';

/**
 * A malformed numeric env var must fall back to its default. Yielding NaN is
 * the dangerous case: setTimeout(fn, NaN) fires immediately, flagging every
 * message as timed out.
 */
describe('Config numeric env parsing', () => {
    const saved: Record<string, string | undefined> = {};
    const keys = ['MESSAGE_PROCESSING_TIMEOUT', 'STREAM_IDLE_TIMEOUT_MS', 'RPC_CALL_TIMEOUT_MS'];

    beforeEach(() => { keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; }); });
    afterEach(() => {
        keys.forEach(k => {
            if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; }
        });
    });

    it('uses the default when unset', () => {
        expect(Config.messageProcessingTimeout).toBe(600000);
        expect(Config.streamIdleTimeoutMs).toBe(60000);
    });

    it('honours a valid override', () => {
        process.env.MESSAGE_PROCESSING_TIMEOUT = '1234';
        expect(Config.messageProcessingTimeout).toBe(1234);
    });

    it('falls back to the default on a non-numeric value', () => {
        process.env.MESSAGE_PROCESSING_TIMEOUT = '6oo000';
        expect(Config.messageProcessingTimeout).toBe(600000);
    });

    it('falls back to the default on an empty or whitespace value', () => {
        process.env.STREAM_IDLE_TIMEOUT_MS = '   ';
        expect(Config.streamIdleTimeoutMs).toBe(60000);
    });

    it('falls back to the default on a non-positive value', () => {
        process.env.MESSAGE_PROCESSING_TIMEOUT = '0';
        expect(Config.messageProcessingTimeout).toBe(600000);
        process.env.MESSAGE_PROCESSING_TIMEOUT = '-5';
        expect(Config.messageProcessingTimeout).toBe(600000);
    });

    it('does not treat a trailing-garbage value as valid', () => {
        // parseInt('123abc') === 123, which silently accepts a typo.
        process.env.MESSAGE_PROCESSING_TIMEOUT = '123abc';
        expect(Config.messageProcessingTimeout).toBe(600000);
    });

    it('exposes a unary RPC call timeout with a sane default', () => {
        expect(Config.rpcCallTimeoutMs).toBeGreaterThan(0);
    });
});

/**
 * decodeRequest decoded the payload twice and threw the first result away,
 * doubling protobuf decode cost on the hottest path in the library.
 */
describe('decodeRequest', () => {
    const PROTO = `
        syntax = "proto3";
        package P;
        message Req { string a = 1; }
        message Res { string b = 1; }
        service Svc { rpc go (Req) returns (Res); }
    `;

    function factory(): MessageFactory {
        const f = new MessageFactory();
        f.init([]);
        f.parse(PROTO);
        return f;
    }

    it('decodes the inner payload exactly once', () => {
        const f = factory();
        const buf = f.buildRequest('P.Svc.go', { a: 'x' }, 'actor');
        const spy = jest.spyOn(f, 'decodeMessage');
        f.decodeRequest(buf);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('still returns method, actor and decoded data', () => {
        const f = factory();
        const buf = f.buildRequest('P.Svc.go', { a: 'hello' }, 'alice');
        const out = f.decodeRequest(buf);
        expect(out.method).toBe('P.Svc.go');
        expect(out.actor).toBe('alice');
        expect(out.data.a).toBe('hello');
    });
});
