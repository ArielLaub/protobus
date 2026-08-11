/**
 * Integration tests for server-streaming RPC against a real RabbitMQ broker.
 *
 * These tests verify the wire-protocol guarantees documented in
 * `docs/advanced/streaming.md`:
 *
 *  - Multi-chunk delivery in order
 *  - `x-protobus-final` header terminates the client iterator
 *  - Mid-stream errors raise inside `for await`
 *  - Empty-generator streams end cleanly without yielding spurious chunks
 *  - Early `break` releases the pending-stream slot in the dispatcher
 *  - Concurrent same-proxy streams don't cross-contaminate
 *  - Unary RPCs in the same .proto are unaffected (backward compat)
 *
 * Run with a live broker:
 *
 *   docker-compose up -d
 *   npm run test:integration -- streaming.test.ts
 */

import * as protobuf from 'protobufjs';

import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context from '../../lib/context';
import { HandledError } from '../../lib/errors';

const proto = `syntax = "proto3";
package streaming_test;

message TickRequest {
    int32 count = 1;
    int32 fail_at = 2;
    bool emit_nothing = 3;
    int32 delay_ms = 4;
}

message Tick {
    int32 seq = 1;
    string payload = 2;
}

message AddRequest { int32 a = 1; int32 b = 2; }
message AddResponse { int32 sum = 1; }

service Counter {
    rpc add (AddRequest) returns (AddResponse);
    rpc tick (TickRequest) returns (stream Tick);
}`;

class CounterService extends MessageService {
    public get ServiceName(): string { return 'streaming_test.Counter'; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }

    public async add(request: any): Promise<any> {
        return { sum: (request.a || 0) + (request.b || 0) };
    }

    /**
     * Server-streaming handler — declared as `returns (stream Tick)` in the
     * proto. The framework auto-detects this via the responseStream flag on
     * the method descriptor and routes each yielded value as a chunk.
     */
    /** Observable state for the cancellation tests. */
    public produced = 0;
    public sawAbort = false;
    public finished = false;

    public async *tick(request: any, _actor?: string, _id?: string, context?: any): AsyncIterable<any> {
        const count: number = request.count || 0;
        const failAt: number = request.fail_at || 0;
        const emitNothing: boolean = request.emit_nothing === true;

        if (emitNothing) return;

        this.finished = false;
        try {
            for (let i = 0; i < count; i++) {
                if (failAt && i >= failAt) {
                    throw new HandledError(`deliberate failure at chunk ${i}`, 'TEST_FAIL');
                }
                // A long stream stops here when the caller cancels.
                if (context?.signal?.aborted) { this.sawAbort = true; return; }
                this.produced = i + 1;
                yield { seq: i, payload: `chunk-${i}` };
                if (request.delay_ms) {
                    await new Promise((r) => setTimeout(r, request.delay_ms));
                }
            }
        } finally {
            this.finished = true;
        }
    }
}

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('Streaming RPC integration', () => {
    let svc: CounterService;
    let client: any;
    let context: Context;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);
        // Inline proto parse — matches the existing message_service.test.ts pattern.
        (context.factory as any).root = protobuf.parse(proto, { keepCase: true }).root;

        svc = new CounterService(context);
        await svc.init();

        client = new ServiceProxy(context, svc.ServiceName);
        await client.init();
    });

    afterAll(async () => {
        if (context && context.isConnected) {
            await context.connection.disconnect();
        }
    });

    describe('flag detection', () => {
        it('detects the gRPC stream keyword on the response', () => {
            expect(context.factory.isStreamingMethod('streaming_test.Counter.tick')).toBe(true);
        });

        it('returns false for unary methods', () => {
            expect(context.factory.isStreamingMethod('streaming_test.Counter.add')).toBe(false);
        });

        it('returns false (no throw) for unknown methods', () => {
            expect(context.factory.isStreamingMethod('streaming_test.Counter.nope')).toBe(false);
        });
    });

    describe('cancellation', () => {
        it('stops the producer when the caller breaks out of the loop', async () => {
            svc.produced = 0;
            const received: any[] = [];

            for await (const tick of client.tick({ count: 200, delay_ms: 20 })) {
                received.push(tick);
                if (received.length === 3) break;
            }

            expect(received).toHaveLength(3);

            // Give the cancel time to reach the service and take effect.
            const producedAtBreak = svc.produced;
            await new Promise((r) => setTimeout(r, 300));
            expect(svc.sawAbort).toBe(true);
            // An endless generator ticking every 10ms would have produced ~30
            // more by now had nothing stopped it.
            expect(svc.produced).toBeLessThan(producedAtBreak + 10);
            expect(svc.finished).toBe(true);
        }, 20000);

        it('stops the producer when an AbortSignal fires outside the loop', async () => {
            svc.produced = 0;
            const stop = new AbortController();
            const received: any[] = [];

            // The shape a Stop button takes: aborted from elsewhere, not from
            // inside the consuming loop.
            setTimeout(() => stop.abort(), 120);

            try {
                for await (const tick of client.tick({ count: 200, delay_ms: 20 }, undefined, 10000, { signal: stop.signal })) {
                    received.push(tick);
                }
            } catch {
                // Ending an abandoned stream may surface as a throw; either way
                // the loop is over, which is what matters here.
            }

            expect(received.length).toBeGreaterThan(0);

            const producedAtStop = svc.produced;
            await new Promise((r) => setTimeout(r, 300));

            expect(svc.sawAbort).toBe(true);
            expect(svc.produced).toBeLessThan(producedAtStop + 10);
        }, 20000);

        it('leaves an uncancelled stream completely unaffected', async () => {
            const ticks: any[] = [];
            for await (const tick of client.tick({ count: 4 })) {
                ticks.push(tick);
            }
            expect(ticks.map((t) => t.payload)).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3']);
        }, 20000);
    });

    describe('backward compat', () => {
        it('unary add still works alongside streaming', async () => {
            const res = await client.add({ a: 5, b: 7 });
            expect(res).toHaveProperty('sum', 5 + 7);
        });
    });

    describe('happy path', () => {
        it('delivers five chunks in order', async () => {
            const chunks: any[] = [];
            for await (const chunk of client.tick({ count: 5 })) {
                chunks.push(chunk);
            }
            expect(chunks).toHaveLength(5);
            // proto3 default-value stripping makes `seq: 0` invisible on chunk 0.
            // payload is the reliable ordering signal.
            chunks.forEach((c, i) => {
                expect(c.payload).toBe(`chunk-${i}`);
            });
        });

        it('handles a single-chunk stream', async () => {
            const chunks: any[] = [];
            for await (const chunk of client.tick({ count: 1 })) {
                chunks.push(chunk);
            }
            expect(chunks).toHaveLength(1);
        });

        it('handles an empty stream cleanly', async () => {
            const chunks: any[] = [];
            for await (const chunk of client.tick({ emit_nothing: true })) {
                chunks.push(chunk);
            }
            expect(chunks).toHaveLength(0);
        });
    });

    describe('errors', () => {
        it('raises mid-stream errors inside the for-await', async () => {
            const chunks: any[] = [];
            let caught: any = null;
            try {
                for await (const chunk of client.tick({ count: 10, fail_at: 2 })) {
                    chunks.push(chunk);
                }
            } catch (e) {
                caught = e;
            }
            expect(chunks).toHaveLength(2);
            expect(chunks[0].payload).toBe('chunk-0');
            expect(chunks[1].payload).toBe('chunk-1');
            expect(caught).not.toBeNull();
            expect(String(caught.message)).toContain('deliberate failure');
            expect(caught.code).toBe('TEST_FAIL');
        });

        it('raises an error after only one chunk if fail_at=1', async () => {
            const chunks: any[] = [];
            let caught: any = null;
            try {
                for await (const chunk of client.tick({ count: 10, fail_at: 1 })) {
                    chunks.push(chunk);
                }
            } catch (e) {
                caught = e;
            }
            expect(chunks).toHaveLength(1);
            expect(chunks[0].payload).toBe('chunk-0');
            expect(caught).not.toBeNull();
        });
    });

    describe('early termination', () => {
        it('releases pending-stream state on break', async () => {
            let n = 0;
            for await (const _chunk of client.tick({ count: 100 })) {
                n++;
                if (n >= 3) break;
            }

            // Allow the framework a tick to clean up.
            await new Promise(r => setTimeout(r, 50));

            // Read the dispatcher's pendingStreams map; should be empty.
            const dispatcher = (context as any).messageDispatcher;
            expect(dispatcher.pendingStreams.size).toBe(0);
        });
    });

    describe('concurrent streams', () => {
        it('runs two streams on the same proxy without cross-talk', async () => {
            const collect = async (req: any): Promise<any[]> => {
                const acc: any[] = [];
                for await (const c of client.tick(req)) acc.push(c);
                return acc;
            };

            const [a, b] = await Promise.all([
                collect({ count: 5 }),
                collect({ count: 8 }),
            ]);

            expect(a).toHaveLength(5);
            expect(b).toHaveLength(8);
            expect(a.map(c => c.payload)).toEqual(
                Array.from({ length: 5 }, (_, i) => `chunk-${i}`),
            );
            expect(b.map(c => c.payload)).toEqual(
                Array.from({ length: 8 }, (_, i) => `chunk-${i}`),
            );
        });
    });
});
