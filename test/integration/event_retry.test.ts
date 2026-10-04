import * as amqplib from 'amqplib';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';
import { AMQP_URL as BROKER_AMQP_URL } from './helpers/broker';

/**
 * The opt-in event retry ladder, against a real broker.
 *
 * `event_failure_semantics.test.ts` pins the default — a failed event is
 * dropped. This file pins what `eventRetry` changes, including the two things
 * that make an event ladder different from the request one: a redelivery must
 * reach only the subscriber that failed, and it re-runs every handler that
 * matched, not just the one that threw.
 */

const proto = `syntax = "proto3";
package EvtRetry;

message Ping { string id = 1; }

service Sink {}`;

const AMQP = BROKER_AMQP_URL;
const STAMP = Date.now();
const RETRYING = `EvtRetry.Sink.retrying${STAMP}`;
const BYSTANDER = `EvtRetry.Sink.bystander${STAMP}`;

const TOPIC_TRANSIENT = 'EVENT.evtretry.transient';
const TOPIC_ALWAYS = 'EVENT.evtretry.always';
const TOPIC_PAIR = 'EVENT.evtretry.pair';

class Retrying extends MessageService {
    constructor(context: IContext) {
        super(context, { eventRetry: { maxRetries: 2, retryDelayMs: 500 } });
    }
    public get ServiceName(): string { return RETRYING; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }
}

/** Subscribes to the same topics with retry OFF, to prove redeliveries stay put. */
class Bystander extends MessageService {
    constructor(context: IContext) { super(context); }
    public get ServiceName(): string { return BYSTANDER; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('event retry, when opted in', () => {
    let context: Context;

    const transientAttempts: string[] = [];
    const alwaysAttempts: string[] = [];
    const bystanderSaw: string[] = [];
    const firstOfPair: string[] = [];
    const secondOfPair: string[] = [];

    let dlq: amqplib.Replies.AssertQueue;
    let eventsQueue: amqplib.Replies.AssertQueue;
    let dlqMessage: amqplib.GetMessage | false;
    /** The messageId the broker saw on the original publish, snooped off the exchange. */
    let publishedMessageId: string | undefined;
    let snoopQueue = '';

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP, []);
        context.factory.parse(proto, 'EvtRetry.Sink');

        const sink = new Retrying(context);
        await sink.init();
        const bystander = new Bystander(context);
        await bystander.init();

        // Fails once, then succeeds — the case retry exists for.
        await sink.subscribeEvent('EvtRetry.Ping', async (event: any) => {
            transientAttempts.push(event.id);
            if (transientAttempts.filter(id => id === event.id).length === 1) {
                throw new Error(`transient failure for ${event.id}`);
            }
        }, TOPIC_TRANSIENT);

        // Never succeeds — must end on the DLQ, not in the queue forever.
        await sink.subscribeEvent('EvtRetry.Ping', async (event: any) => {
            alwaysAttempts.push(event.id);
            throw new Error(`permanent failure for ${event.id}`);
        }, TOPIC_ALWAYS);

        // Two handlers on one topic, the second failing: a retry re-runs both.
        await sink.subscribeEvent('EvtRetry.Ping', async (event: any) => {
            firstOfPair.push(event.id);
        }, TOPIC_PAIR);
        await sink.subscribeEvent('EvtRetry.Ping', async (event: any) => {
            secondOfPair.push(event.id);
            if (secondOfPair.filter(id => id === event.id).length === 1) {
                throw new Error(`pair failure for ${event.id}`);
            }
        }, TOPIC_PAIR);

        // A different subscriber on the failing topic. It must see the original
        // publish once and never see a redelivery meant for someone else.
        await bystander.subscribeEvent('EvtRetry.Ping', async (event: any) => {
            bystanderSaw.push(event.id);
        }, TOPIC_ALWAYS);

        // Snoop the original publish so the DLQ copy's messageId can be
        // compared against it rather than merely asserted to exist.
        const snoopConn = await amqplib.connect(AMQP);
        const snoopCh = await snoopConn.createChannel();
        snoopQueue = (await snoopCh.assertQueue('', { exclusive: true })).queue;
        await snoopCh.bindQueue(snoopQueue, 'proto.bus.events', TOPIC_ALWAYS);
        await snoopCh.consume(snoopQueue, (msg) => {
            if (msg && publishedMessageId === undefined) {
                publishedMessageId = msg.properties.messageId;
            }
        }, { noAck: true });

        await context.publishEvent('EvtRetry.Ping', { id: 'transient-1' }, TOPIC_TRANSIENT);
        await context.publishEvent('EvtRetry.Ping', { id: 'always-1' }, TOPIC_ALWAYS);
        await context.publishEvent('EvtRetry.Ping', { id: 'pair-1' }, TOPIC_PAIR);

        // 2 retries at 500ms, plus handling time on each hop.
        await wait(6000);

        await snoopCh.close();
        await snoopConn.close();

        const raw = await amqplib.connect(AMQP);
        const ch = await raw.createChannel();
        dlq = await ch.checkQueue(`${RETRYING}.Events.DLQ`);
        eventsQueue = await ch.checkQueue(`${RETRYING}.Events`);
        dlqMessage = await ch.get(`${RETRYING}.Events.DLQ`, { noAck: true });
        await ch.close();
        await raw.close();
    }, 60000);

    afterAll(async () => {
        try {
            const raw = await amqplib.connect(AMQP);
            const ch = await raw.createChannel();
            for (const svc of [RETRYING, BYSTANDER]) {
                for (const q of [
                    svc, `${svc}.DLQ`, `${svc}.Retry`, `${svc}.Events`,
                    `${svc}.Events.Retry`, `${svc}.Events.DLQ`,
                ]) {
                    await ch.deleteQueue(q).catch(() => undefined);
                }
                for (const x of [
                    `${svc}.Retry.Exchange`,
                    `${svc}.Events.Retry.Exchange`, `${svc}.Events.Redelivery`,
                ]) {
                    await ch.deleteExchange(x).catch(() => undefined);
                }
            }
            await ch.close();
            await raw.close();
        } catch { /* best effort */ }
        if (context && context.isConnected) { await context.connection.disconnect(); }
    }, 30000);

    it('redelivers a transiently failing event until it succeeds', () => {
        expect(transientAttempts).toEqual(['transient-1', 'transient-1']);
    });

    it('stops after maxRetries and dead-letters the event', () => {
        // The original delivery plus two retry hops.
        expect(alwaysAttempts).toEqual(['always-1', 'always-1', 'always-1']);
        expect(dlq.messageCount).toBeGreaterThanOrEqual(1);
    });

    it('records the failure on the dead-lettered copy', () => {
        expect(dlqMessage).not.toBe(false);
        const headers = (dlqMessage as amqplib.GetMessage).properties.headers ?? {};
        expect(headers['x-retry-count']).toBe(2);
        expect(headers['x-original-routing-key']).toBe(TOPIC_ALWAYS);
        // Name only. An unhandled error's message may carry payload, so
        // safeErrorSummary withholds it; a HandledError's is included, because
        // that text was written to be seen.
        expect(String(headers['x-last-error'])).toBe('Error');
    });

    it('keeps the same messageId across every hop', () => {
        // Identity is what makes an idempotent handler possible. A fresh id
        // per hop would make the retried copy unrecognisable as the same
        // logical event — exactly when a consumer needs the old one.
        expect(publishedMessageId).toBeTruthy();
        expect((dlqMessage as amqplib.GetMessage).properties.messageId)
            .toBe(publishedMessageId);
    });

    it('confines the redelivery to the subscriber that failed', () => {
        // The bystander is bound to the same topic on the events exchange. A
        // retry that dead-lettered back to proto.bus.events would fan out and
        // hit it again for work it already completed.
        expect(bystanderSaw).toEqual(['always-1']);
    });

    it('re-runs every handler that matched, not only the one that threw', () => {
        // At-least-once per handler, not per failure. Documented, not desired:
        // a handler sharing a topic with a failing one must be idempotent.
        expect(secondOfPair).toEqual(['pair-1', 'pair-1']);
        expect(firstOfPair).toEqual(['pair-1', 'pair-1']);
    });

    it('leaves nothing parked on the events queue', () => {
        expect(eventsQueue.messageCount).toBe(0);
        expect(eventsQueue.consumerCount).toBe(1);
    });
});
