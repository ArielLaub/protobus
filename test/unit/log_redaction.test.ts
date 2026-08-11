import { EventEmitter } from 'events';

import Connection from '../../lib/connection';
import EventListener from '../../lib/event_listener';
import { BaseListener } from '../../lib/base_listener';
import { ILogger, set as setLogger, DefaultLogger, setLevel, LogLevel } from '../../lib/logger';
import {
    sanitizeErrorForClient,
    safeErrorSummary,
    InternalServiceError,
    HandledError,
} from '../../lib/errors';

/**
 * The audit's information-exposure finding: the library logged message
 * payloads and connection credentials through paths that are enabled by
 * default, so any deployment shipping stdout to an aggregator was also
 * shipping whatever crossed the bus.
 *
 * The method here is the one the audit prescribes — put a unique marker inside
 * the sensitive value, exercise the path, and assert the marker never reaches
 * any log sink at the DEFAULT level.
 */

const SECRET = 'MARKER-e7f1c2a9-do-not-log';

/** Captures every level, so nothing can hide in a channel we forgot to check. */
class CapturingLogger implements ILogger {
    public lines: string[] = [];
    private record(m: any) {
        this.lines.push(typeof m === 'string' ? m : String(m?.stack || m?.message || m));
    }
    info(m: any) { this.record(m); }
    warn(m: any) { this.record(m); }
    debug(m: any) { this.record(m); }
    error(m: any) { this.record(m); }
    get text() { return this.lines.join('\n'); }
}

class StubConnection extends EventEmitter {
    public isConnected = true;
    public isReconnecting = false;
    async openChannel(): Promise<any> {
        return { prefetch: async () => undefined, consume: async () => ({ consumerTag: 't' }), close: async () => undefined };
    }
    async closeChannel() { return undefined; }
    async declareExchange() { return undefined; }
    async declareQueue(_ch: any, name: string) { return name || 'anonymous.queue'; }
    async bindQueue() { return undefined; }
    async unbindQueue() { return undefined; }
    async deleteQueue() { return undefined; }
    async ack() { return undefined; }
    async reject() { return undefined; }
    async consume() { return { consumerTag: 'tag' }; }
    async cancel() { return undefined; }
    async purgeQueue() { return undefined; }
    async publish() { return undefined; }
    async publishToQueue() { return undefined; }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }
}

describe('logs are payload-free at the default level', () => {
    let log: CapturingLogger;

    beforeEach(() => {
        log = new CapturingLogger();
        setLogger(log);
        setLevel(LogLevel.Info); // the default; debug is opt-in
    });

    afterEach(() => {
        setLogger(new DefaultLogger());
        setLevel(LogLevel.Info);
    });

    it('does not log the body of an unhandled message', async () => {
        const listener: any = new (BaseListener as any)(new StubConnection() as any);
        const body = Buffer.from(JSON.stringify({ password: SECRET }));

        await listener.defaultHandler(body, 'cid-1');

        expect(log.text).not.toContain(SECRET);
        // JSON.stringify(Buffer) emits {"type":"Buffer","data":[123,34,...]},
        // so the payload leaks as decimal bytes rather than as text. Assert on
        // the serialised form too, or this passes while still leaking.
        expect(log.text).not.toContain('"type":"Buffer"');
        expect(log.text).not.toContain([...body.subarray(0, 8)].join(','));
        // It must still say something actionable.
        expect(log.text.toLowerCase()).toContain('unhandled');
    });

    it('does not log the body of an unhandled event', async () => {
        // An event that decodes with no topic takes the "ignoring unhandled
        // event" branch, which serialised the whole decoded event.
        const factory: any = {
            decodeEvent: () => ({ data: { token: SECRET }, type: 'X', topic: undefined }),
        };
        const listener: any = new EventListener(new StubConnection() as any, factory);

        await listener.defaultHandler(Buffer.from('encoded'), 'cid-2', {}, {});

        expect(log.text).not.toContain(SECRET);
        expect(log.text.toLowerCase()).toContain('event');
    });

    it('does not log message content when a handler fails', async () => {
        const conn = new Connection();
        const events: string[] = [];
        const channel: any = {
            prefetch: async () => undefined,
            consume: async (_q: string, h: any) => { channel._h = h; return { consumerTag: 't' }; },
            ack: () => events.push('ack'),
            reject: () => events.push('reject'),
            publish: (_e: string, _r: string, _c: Buffer, _o: any, cb: any) => { if (cb) setImmediate(() => cb(null)); return true; },
            sendToQueue: (_q: string, _c: Buffer, _o: any, cb: any) => { if (cb) setImmediate(() => cb(null)); return true; },
            once: () => channel,
        };

        await conn.consume(channel, 'Q', async () => {
            throw new Error(`upstream rejected card ${SECRET}`);
        }, {}, true);

        await channel._h({
            content: Buffer.from(JSON.stringify({ card: SECRET })),
            fields: { routingKey: 'REQUEST.S.A.m' },
            properties: { correlationId: 'cid-9', headers: {} },
        });

        // The handler's own error text is the service's to disclose, but the
        // message body must never be logged by the framework itself.
        expect(log.lines.filter(l => l.includes(JSON.stringify({ card: SECRET })))).toEqual([]);
    });

    it('does not log the request when a streaming request fails to build', async () => {
        const MessageFactory = require('../../lib/message_factory').default;
        const ServiceProxy = require('../../lib/service_proxy').default;

        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(`syntax = "proto3";
package T;
message Req { string token = 1; }
message Chunk { string v = 1; }
service Api { rpc play (T.Req) returns (stream T.Chunk); }`, 'T.Api');

        // Force the encode to fail with the payload in hand.
        factory.buildRequest = () => { throw new Error('encode failed'); };

        const ctx: any = {
            factory,
            connection: new StubConnection(),
            publishMessage: async () => undefined,
            publishStreaming: () => ({
                [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
            }),
        };

        const proxy: any = new ServiceProxy(ctx, 'T.Api');
        await proxy.init();

        try {
            for await (const _chunk of proxy.play({ token: SECRET })) { /* drain */ }
        } catch { /* the build error surfaces here */ }

        expect(log.text).not.toContain(SECRET);
        // Proves the failing path really ran.
        expect(log.text).toContain('failed building streaming request');
    });

    it('does not put raw error text into retry metadata headers', async () => {
        const conn = new Connection();
        const sent: any[] = [];
        const channel: any = {
            prefetch: async () => undefined,
            consume: async (_q: string, h: any) => { channel._h = h; return { consumerTag: 't' }; },
            ack: () => undefined,
            reject: () => undefined,
            publish: (_e: string, _r: string, _c: Buffer, o: any, cb: any) => {
                sent.push(o); if (cb) setImmediate(() => cb(null)); return true;
            },
            sendToQueue: (_q: string, _c: Buffer, o: any, cb: any) => {
                sent.push(o); if (cb) setImmediate(() => cb(null)); return true;
            },
            once: () => channel,
        };

        await conn.consume(channel, 'Q', async () => {
            throw new Error(`connection failed for user admin password ${SECRET}`);
        }, {}, true, {
            maxRetries: 2,
            retryQueueName: 'Q.Retry',
            retryExchangeName: 'Q.Retry.Ex',
            dlqName: 'Q.DLQ',
        });

        await channel._h({
            content: Buffer.from('body'),
            fields: { routingKey: 'REQUEST.S.A.m' },
            properties: { correlationId: 'cid-10', headers: {} },
        });

        // x-last-error rides along to the retry queue and the DLQ, where it is
        // read by dashboards and ops tooling — a raw exception string can carry
        // credentials straight out of the process.
        const headers = sent.map(o => JSON.stringify(o?.headers || {})).join('\n');
        expect(headers).not.toContain(SECRET);
    });
});

describe('service error boundary', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

    it('forwards an unhandled error message to the caller by default', () => {
        // 1.x behaviour, deliberately preserved: a protobus caller is another
        // of your own services, already inside the trust boundary. Suppressing
        // this by default would degrade every consumer's error reporting to
        // guard against a downstream gateway's bug.
        const err = new Error(`db connect failed ${SECRET}`);
        expect((sanitizeErrorForClient(err) as Error).message).toContain(SECRET);
    });

    it('substitutes a generic error when exposure is disabled', () => {
        process.env.PROTOBUS_EXPOSE_INTERNAL_ERRORS = 'false';
        const err = new Error(`db connect failed ${SECRET}`);
        const wire = sanitizeErrorForClient(err, 'cid-77') as Error;

        expect(wire).toBeInstanceOf(InternalServiceError);
        expect(wire.message).not.toContain(SECRET);
        expect(wire.message).toContain('cid-77'); // joinable to the real log
    });

    it('always forwards a HandledError, exposure setting notwithstanding', () => {
        process.env.PROTOBUS_EXPOSE_INTERNAL_ERRORS = 'false';
        const handled = new HandledError('invalid_params', 'INVALID_PARAMS');

        // Raising a HandledError IS the decision to tell the caller something.
        expect(sanitizeErrorForClient(handled)).toBe(handled);
    });

    it('never puts a raw message in safeErrorSummary, but keeps handled ones', () => {
        expect(safeErrorSummary(new Error(`boom ${SECRET}`))).not.toContain(SECRET);
        expect(safeErrorSummary(new HandledError('invalid_params', 'INVALID_PARAMS')))
            .toContain('invalid_params');
    });
});
