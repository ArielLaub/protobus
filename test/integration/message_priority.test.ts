/**
 * Message priority against a real broker.
 *
 * The unit suite pins the queue arguments and the publish properties. What can
 * only be checked here is that RabbitMQ actually behaves the way the design
 * assumes it does — including the two facts the backward-compatibility promise
 * rests on:
 *
 *   - a `priority` published to a queue that is NOT a priority queue is
 *     ignored, not rejected (new publisher → old consumer), and
 *   - adding `x-max-priority` to a queue that already exists is a 406 that
 *     closes the channel (which is why enabling it needs an operator).
 */

import * as amqplib from 'amqplib';

import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';
import Config from '../../lib/config';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

/** Unique per run: queues are durable, and their arguments are immutable. */
const STAMP = `P${Date.now()}`;

/**
 * The consumer prefetch these tests run at, and the quantity the ordering
 * assertions are stated in terms of. Named rather than repeated, because the
 * saturation check below has to compare against the SAME number the service was
 * configured with — a literal in one place and not the other is how this test
 * would start measuring something else.
 */
const PREFETCH = 1;

function protoFor(pkg: string): string {
    return `syntax = "proto3";
package ${pkg};

message Request { string tag = 1; }
message Response { string tag = 1; }

service Service {
    rpc handle(${pkg}.Request) returns(${pkg}.Response);
}`;
}

/** Records the order messages were handled in; the first one blocks on a gate. */
class RecordingService extends MessageService {
    public handled: string[] = [];
    /** Concurrent handler invocations, and the high-water mark of that. */
    public inFlight = 0;
    public peakInFlight = 0;
    public firstEntered: Promise<void>;
    private signalFirstEntered: () => void = () => undefined;
    private gate: Promise<void> = Promise.resolve();
    private openGate: () => void = () => undefined;
    private gateArmed = false;

    constructor(context: IContext, private pkg: string, maxPriority?: number) {
        super(context, { maxConcurrent: PREFETCH, retry: { maxRetries: 0 }, maxPriority });
        this.firstEntered = new Promise<void>((resolve) => { this.signalFirstEntered = resolve; });
    }

    /** Block the first delivery, so a backlog builds up behind it. */
    armGate() {
        this.gateArmed = true;
        this.gate = new Promise<void>((resolve) => { this.openGate = resolve; });
    }
    releaseGate() { this.openGate(); }

    public get ServiceName(): string { return `${this.pkg}.Service`; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return protoFor(this.pkg); }

    public async handle(request: any): Promise<any> {
        this.inFlight++;
        if (this.inFlight > this.peakInFlight) { this.peakInFlight = this.inFlight; }
        try {
            if (this.gateArmed) {
                this.gateArmed = false;
                this.signalFirstEntered();
                await this.gate;
            }
            this.handled.push(request.tag);
            return { tag: request.tag };
        } finally {
            this.inFlight--;
        }
    }
}

async function buildProxy(context: Context, pkg: string): Promise<any> {
    context.factory.parse(protoFor(pkg), `${pkg}.Service`);
    const proxy = new ServiceProxy(context, `${pkg}.Service`);
    await proxy.init();
    return proxy;
}

/** Delete a service's queues so a re-run is not blocked by stale arguments. */
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('a priority queue lets a control message overtake a bulk backlog', () => {
    const PKG = `${STAMP}Hi`;
    let context: Context;
    let service: RecordingService;
    let proxy: any;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);
        service = new RecordingService(context, PKG, Config.RECOMMENDED_MAX_PRIORITY);
        service.armGate();
        await service.init();
        proxy = await buildProxy(context, PKG);
    }, 30000);

    afterAll(async () => {
        await context.connection.disconnect();
        await cleanupQueues([`${PKG}.Service`, `${PKG}.Service.Events`]);
    }, 30000);

    it('delivers the high-priority message ahead of everything still queued', async () => {
        const BULK = 20;

        // Fill the queue. With prefetch 1 the consumer takes one and blocks on
        // the gate; the other 19 pile up in the broker.
        for (let i = 0; i < BULK; i++) {
            await proxy.handle(
                { tag: `bulk-${i}` }, undefined, false, undefined,
                { priority: Config.PRIORITY_NORMAL },
            );
        }
        await service.firstEntered;
        await sleep(500); // let the rest settle into the queue

        // PRECONDITION, asserted rather than assumed: the consumer must be
        // SATURATED — every prefetch slot occupied by a held handler — or this
        // test measures the wrong quantity entirely.
        //
        // Protobus does not serialise deliveries (amqplib does not await the
        // consume callback), so any slot this gate does not hold keeps pulling
        // from the queue. Raise maxConcurrent while gating only the first
        // delivery and the remaining slots quietly drain the whole backlog
        // before the control message is even published — leaving nothing to
        // overtake and producing a number that looks like a priority failure
        // but is really a drain-rate measurement.
        //
        // Not hypothetical, and not a client quirk. Gating only the first
        // delivery at a prefetch of 5 gives a peak in-flight of 2 — the SAME
        // number measured independently in protobus-py, whose AMQP client
        // (aio-pika) also does not await its consume callback. Two runtimes,
        // two clients, one number: the cause is protobus's shared delivery
        // design, not something tunable in either driver.
        //
        // Why both ports missed it: at a prefetch of 1 this precondition is
        // free, because holding one message saturates a one-slot consumer by
        // definition. Both ports started there, so the assumption never had to
        // be stated and the harness looked correct right up until someone
        // raised the parameter. A test written at a parameter's lowest value
        // can hide its own precondition.
        if (service.peakInFlight !== PREFETCH) {
            throw new Error(
                `consumer not saturated: peak in-flight ${service.peakInFlight} != prefetch ` +
                `${PREFETCH}. This test would be measuring the drain rate, not the prefetch ` +
                `window. Hold every delivery, not just the first, or set PREFETCH to match.`,
            );
        }

        // The control message arrives LAST of all, and behind 19 others.
        await proxy.handle(
            { tag: 'CONTROL' }, undefined, false, undefined,
            { priority: Config.PRIORITY_CONTROL },
        );
        await sleep(500);

        service.releaseGate();

        const deadline = Date.now() + 20000;
        while (service.handled.length < BULK + 1 && Date.now() < deadline) {
            await sleep(100);
        }

        expect(service.handled).toHaveLength(BULK + 1);

        // Published 21st, handled 2nd. The one message ahead of it is the one
        // already prefetched into the consumer when it arrived — priority
        // reorders the queue, and cannot reach a message the broker has
        // already handed out. That is the documented limitation, and this
        // assertion is deliberately written to show it rather than hide it.
        const at = service.handled.indexOf('CONTROL');
        expect(at).toBe(1);
        expect(service.handled[0]).toMatch(/^bulk-/);
    }, 60000);
});

describe('new publisher against an old (non-priority) consumer', () => {
    const PKG = `${STAMP}Old`;
    let context: Context;
    let service: RecordingService;
    let proxy: any;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);
        // No maxPriority: a plain queue, exactly as every existing deployment
        // declares it today.
        service = new RecordingService(context, PKG);
        await service.init();
        proxy = await buildProxy(context, PKG);
    }, 30000);

    afterAll(async () => {
        await context.connection.disconnect();
        await cleanupQueues([`${PKG}.Service`, `${PKG}.Service.Events`]);
    }, 30000);

    it('accepts a prioritised message without error and ignores the priority', async () => {
        await proxy.handle({ tag: 'a' }, undefined, false, undefined, { priority: 0 });
        await proxy.handle({ tag: 'HIGH' }, undefined, false, undefined, { priority: 2 });
        await proxy.handle({ tag: 'c' }, undefined, false, undefined, { priority: 0 });

        const deadline = Date.now() + 15000;
        while (service.handled.length < 3 && Date.now() < deadline) { await sleep(100); }

        // Delivered, and in publish order: the broker ignored the priority
        // rather than rejecting the message. This is what lets an upgraded
        // publisher run against a consumer that has not been upgraded.
        expect(service.handled).toEqual(['a', 'HIGH', 'c']);
        expect(context.isConnected).toBe(true);
    }, 30000);

    it('still answers an RPC that carries a priority', async () => {
        const result = await proxy.handle(
            { tag: 'rpc' }, undefined, true, 15000, { priority: 2 },
        );
        expect(result.tag).toBe('rpc');
    }, 30000);
});

describe('old publisher against a new (priority) consumer', () => {
    const PKG = `${STAMP}New`;
    let context: Context;
    let service: RecordingService;
    let proxy: any;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);
        service = new RecordingService(context, PKG, Config.RECOMMENDED_MAX_PRIORITY);
        await service.init();
        proxy = await buildProxy(context, PKG);
    }, 30000);

    afterAll(async () => {
        await context.connection.disconnect();
        await cleanupQueues([`${PKG}.Service`, `${PKG}.Service.Events`]);
    }, 30000);

    it('serves a caller that sets no priority at all', async () => {
        // No options argument whatsoever — the pre-upgrade call signature.
        const result = await proxy.handle({ tag: 'legacy' }, undefined, true, 15000);
        expect(result.tag).toBe('legacy');
    }, 30000);
});

describe('enabling maxPriority on an existing queue', () => {
    const PKG = `${STAMP}Mig`;

    afterAll(async () => {
        await cleanupQueues([`${PKG}.Service`, `${PKG}.Service.Events`]);
    }, 30000);

    /**
     * The migration note in docs/advanced/priority.md claims this fails. If it
     * ever stopped failing the docs would be sending operators through an
     * unnecessary outage, so the claim is pinned here rather than asserted in
     * prose alone.
     */
    it('fails with PRECONDITION_FAILED until an operator deletes the queue', async () => {
        const before = new Context();
        await before.init(AMQP_CONNECTION_STRING, []);
        const plain = new RecordingService(before, PKG);
        await plain.init();
        await before.connection.disconnect();

        const after = new Context();
        await after.init(AMQP_CONNECTION_STRING, []);
        const prioritised = new RecordingService(after, PKG, Config.RECOMMENDED_MAX_PRIORITY);

        await expect(prioritised.init()).rejects.toThrow(/PRECONDITION[_-]FAILED/i);

        await after.connection.disconnect().catch(() => undefined);
    }, 60000);
});
