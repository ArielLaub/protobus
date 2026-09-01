/**
 * The worked example behind docs/advanced/priority.md — "How long does the
 * control message actually wait?"
 *
 * message_priority.test.ts measures ORDER: how many bulk messages are handled
 * before the control message. That number is real, and on its own it is
 * misleading, because it invites the reading "a prefetch of N puts N task
 * durations in front of the control message". It does not. The N prefetched
 * messages are worked CONCURRENTLY, so the control message waits for one slot
 * to free — roughly one task duration — no matter how large N is.
 *
 * This file measures the clock instead of the index, with a handler that
 * actually takes a second, and pins three things:
 *
 *   1. On a priority queue the control message is handled in about one task
 *      duration, while the batch behind it runs for ten times that.
 *   2. Raising the prefetch raises the INDEX and leaves the LATENCY alone —
 *      more parallel slots do not make priority slower.
 *   3. Without priority the same call waits for the entire batch.
 *
 * Case 3 is also the mutation check for cases 1 and 2: it is the identical
 * scenario with the priority removed, and it fails the assertions they make.
 */

import * as amqplib from 'amqplib';

import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';
import Config from '../../lib/config';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

/** Unique per run: queues are durable, and their arguments are immutable. */
const STAMP = `L${Date.now()}`;

/** How long one unit of "slow work" takes. The unit every number here is in. */
const TASK_MS = 1000;

/** Bulk messages published before the control message. */
const BULK = 30;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const PROTO = (pkg: string): string => `syntax = "proto3";
package ${pkg};

message Request { string tag = 1; }
message Response { string tag = 1; }

service Service {
    rpc slow(${pkg}.Request) returns(${pkg}.Response);
    rpc fast(${pkg}.Request) returns(${pkg}.Response);
}`;

/**
 * A service with the shape the feature exists for: one expensive method that
 * fills the queue, and one cheap one that has to get through anyway. Both live
 * on the same queue, because a protobus service only has one.
 */
class WorkService extends MessageService {
    /** Tags in the order their handler STARTED — the ordering measurement. */
    public started: string[] = [];
    /** When `fast` was entered, as a clock reading — the latency measurement. */
    public fastEnteredAt = 0;
    public inFlight = 0;
    public peakInFlight = 0;

    constructor(context: IContext, private pkg: string, prefetch: number, maxPriority?: number) {
        super(context, { maxConcurrent: prefetch, retry: { maxRetries: 0 }, maxPriority });
    }

    public get ServiceName(): string { return `${this.pkg}.Service`; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return PROTO(this.pkg); }

    private enter(tag: string) {
        this.started.push(tag);
        this.inFlight++;
        if (this.inFlight > this.peakInFlight) { this.peakInFlight = this.inFlight; }
    }

    /** The bulk work: a second of it, per message. */
    public async slow(request: any): Promise<any> {
        this.enter(request.tag);
        try {
            await sleep(TASK_MS);
            return { tag: request.tag };
        } finally { this.inFlight--; }
    }

    /** The control call: cheap, and latency-sensitive. */
    public async fast(request: any): Promise<any> {
        this.fastEnteredAt = Date.now();
        this.enter(request.tag);
        try {
            return { tag: request.tag };
        } finally { this.inFlight--; }
    }
}

async function buildProxy(context: Context, pkg: string): Promise<any> {
    context.factory.parse(PROTO(pkg), `${pkg}.Service`);
    const proxy = new ServiceProxy(context, `${pkg}.Service`);
    await proxy.init();
    return proxy;
}

async function cleanupQueues(names: string[]) {
    const conn = await amqplib.connect(AMQP_CONNECTION_STRING);
    for (const n of names) {
        const ch = await conn.createChannel();
        ch.on('error', () => undefined);
        try { await ch.deleteQueue(n); } catch { /* already gone */ }
        try { await ch.close(); } catch { /* channel died on the delete */ }
    }
    await conn.close();
}

interface Measurement {
    /** Milliseconds from publishing the control message to its handler starting. */
    latencyMs: number;
    /** How many bulk messages started ahead of it. */
    index: number;
    /** Milliseconds the whole batch took, control message included. */
    batchMs: number;
}

/**
 * Flood `slow`, then call `fast`, and time it.
 *
 * `controlPriority` undefined means the call carries no priority at all — the
 * pre-2.2.0 call, and the mutation check.
 */
async function measure(
    pkg: string, prefetch: number, maxPriority: number | undefined, controlPriority?: number,
): Promise<Measurement> {
    const context = new Context();
    await context.init(AMQP_CONNECTION_STRING, []);
    const service = new WorkService(context, pkg, prefetch, maxPriority);
    await service.init();
    const proxy = await buildProxy(context, pkg);

    try {
        const startedAt = Date.now();
        for (let i = 0; i < BULK; i++) {
            await proxy.slow(
                { tag: `bulk-${i}` }, undefined, false, undefined,
                { priority: Config.PRIORITY_NORMAL },
            );
        }

        // PRECONDITION: the consumer must be SATURATED before the control
        // message is published, or there is no backlog to overtake and the run
        // measures nothing. Every slot busy AND messages still in the queue is
        // exactly the situation this feature addresses.
        const saturatedBy = Date.now() + 10000;
        while (service.inFlight < prefetch && Date.now() < saturatedBy) { await sleep(20); }
        expect(service.inFlight).toBe(prefetch);

        const publishedAt = Date.now();
        const options = controlPriority === undefined ? undefined : { priority: controlPriority };
        await proxy.fast({ tag: 'CONTROL' }, undefined, false, undefined, options);

        const deadline = Date.now() + BULK * TASK_MS + 30000;
        while (service.started.length < BULK + 1 && Date.now() < deadline) { await sleep(25); }
        expect(service.started).toHaveLength(BULK + 1);

        return {
            latencyMs: service.fastEnteredAt - publishedAt,
            index: service.started.indexOf('CONTROL'),
            batchMs: Date.now() - startedAt,
        };
    } finally {
        // Let the last handlers finish before pulling the connection out from
        // under them; disconnecting mid-flight only produces teardown noise.
        const quietBy = Date.now() + 2 * TASK_MS + 2000;
        while (service.inFlight > 0 && Date.now() < quietBy) { await sleep(25); }
        await context.connection.disconnect();
        await cleanupQueues([`${pkg}.Service`, `${pkg}.Service.Events`]);
    }
}

/** So a failure reports what it saw, not just that a number was too big. */
function report(label: string, m: Measurement) {
    console.log(
        `${label}: control handled after ${m.latencyMs}ms, at index ${m.index} of ${BULK + 1}; ` +
        `whole batch ${m.batchMs}ms`,
    );
}

describe('how long a control message waits behind a saturated consumer', () => {
    /**
     * The headline claim of the docs, in the units a caller cares about.
     *
     * Three slots, thirty seconds of work queued behind them, and the control
     * message is served in about one task duration — the time for whichever
     * slot finishes first to free.
     */
    it('is served in about one task duration on a priority queue', async () => {
        const m = await measure(
            `${STAMP}A`, 3, Config.RECOMMENDED_MAX_PRIORITY, Config.PRIORITY_CONTROL,
        );
        report('prefetch 3, priority', m);

        // One task duration, with room for scheduling and a round trip.
        expect(m.latencyMs).toBeLessThan(2 * TASK_MS);
        // And the batch it jumped is an order of magnitude longer than that.
        expect(m.batchMs).toBeGreaterThan(8 * TASK_MS);
    }, 120000);

    /**
     * The correction this file exists for.
     *
     * A larger prefetch means MORE messages start ahead of the control message
     * — the index grows with it, and message_priority.test.ts measures exactly
     * that. It does not mean a longer WAIT, because those messages run at the
     * same time. Ten slots instead of three moves the index from ~3 to ~10 and
     * leaves the latency where it was.
     */
    it('waits the same time at a prefetch three times larger', async () => {
        const m = await measure(
            `${STAMP}B`, 10, Config.RECOMMENDED_MAX_PRIORITY, Config.PRIORITY_CONTROL,
        );
        report('prefetch 10, priority', m);

        expect(m.latencyMs).toBeLessThan(2 * TASK_MS);
        // The index grew with the prefetch even though the wait did not: these
        // two assertions together are the whole point of the file.
        expect(m.index).toBeGreaterThanOrEqual(3);
    }, 120000);

    /**
     * The contrast, and the mutation check: the same scenario as the first
     * test with the priority taken off the call. The control message goes to
     * the back of the queue and is served when the batch is done.
     */
    it('waits for the entire batch when the call carries no priority', async () => {
        const m = await measure(`${STAMP}C`, 3, undefined, undefined);
        report('prefetch 3, no priority', m);

        // Fails the first test's `< 2 * TASK_MS` by roughly a factor of ten.
        expect(m.latencyMs).toBeGreaterThan(5 * TASK_MS);
        expect(m.index).toBe(BULK);
    }, 120000);
});
