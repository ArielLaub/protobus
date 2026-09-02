import * as amqplib from 'amqplib';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';

/**
 * What actually happens when an event handler throws.
 *
 * Measured rather than reasoned about, because the code alone reads three
 * different ways depending on which layer you stop at. `EventListener` sets
 * `lateAck` and supplies no retry options; the throw propagates out of the
 * handler, and the connection layer's terminal branch answers it with
 * `channel.reject(msg, false)`. The consequences below are the ones that
 * matter to anyone publishing events, and none of them is documented anywhere
 * else, so they are pinned here.
 *
 * The behaviour is NOT changed in 2.3.0. It is a real gap — a durable queue
 * and a persistent message, and a transient handler failure still loses the
 * event permanently — but retrying events instead would declare new queues in
 * every existing deployment and change delivery semantics for every consumer
 * that has been running against this behaviour. That belongs in an opt-in, or
 * in a major, not in a minor. This test exists so the day it changes, it
 * changes deliberately.
 */

const proto = `syntax = "proto3";
package EvtSem;

message Ping { string id = 1; }

service Sink {}`;

const AMQP = 'amqp://guest:guest@localhost:5672/';
const SERVICE = `EvtSem.Sink.run${Date.now()}`;

class Sink extends MessageService {
    constructor(context: IContext) { super(context); }
    public get ServiceName(): string { return SERVICE; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }
}

describe('an event handler that throws', () => {
    let context: Context;
    const failed: string[] = [];
    const succeeded: string[] = [];
    let queueAfter: amqplib.Replies.AssertQueue;
    let dlqExists = true;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP, []);
        context.factory.parse(proto, 'EvtSem.Sink');

        const sink = new Sink(context);
        await sink.init();

        await sink.subscribeEvent('EvtSem.Ping', async (event: any) => {
            failed.push(event.id);
            throw new Error(`handler failed for ${event.id}`);
        }, 'EVENT.evtsem.bad');
        await sink.subscribeEvent('EvtSem.Ping', async (event: any) => {
            succeeded.push(event.id);
        }, 'EVENT.evtsem.good');

        // More events than the default prefetch (1), so an unacknowledged
        // message would visibly stall the consumer.
        for (let i = 0; i < 5; i++) {
            await context.publishEvent('EvtSem.Ping', { id: `bad-${i}` }, 'EVENT.evtsem.bad');
        }
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Published only AFTER the failures, to see whether anything is still
        // being consumed.
        await context.publishEvent('EvtSem.Ping', { id: 'good-1' }, 'EVENT.evtsem.good');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const raw = await amqplib.connect(AMQP);
        const ch = await raw.createChannel();
        queueAfter = await ch.checkQueue(`${SERVICE}.Events`);
        await ch.close();
        // checkQueue on a missing queue kills the channel, so use a fresh one.
        const probe = await raw.createChannel();
        probe.on('error', () => undefined);
        try {
            await probe.checkQueue(`${SERVICE}.Events.DLQ`);
        } catch {
            dlqExists = false;
        }
        await raw.close();
    }, 40000);

    afterAll(async () => {
        try {
            const raw = await amqplib.connect(AMQP);
            const ch = await raw.createChannel();
            for (const q of [SERVICE, `${SERVICE}.DLQ`, `${SERVICE}.Retry`, `${SERVICE}.Events`]) {
                await ch.deleteQueue(q).catch(() => undefined);
            }
            await ch.deleteExchange(`${SERVICE}.Retry.Exchange`).catch(() => undefined);
            await ch.close();
            await raw.close();
        } catch { /* best effort */ }
        if (context && context.isConnected) { await context.connection.disconnect(); }
    }, 30000);

    it('is delivered exactly once — the event is NOT retried', () => {
        expect(failed).toEqual(['bad-0', 'bad-1', 'bad-2', 'bad-3', 'bad-4']);
    });

    it('is discarded: nothing is left on the events queue', () => {
        // Rejected without requeue. Not parked, not redelivered later.
        expect(queueAfter.messageCount).toBe(0);
    });

    it('goes to no dead-letter queue, because events have none', () => {
        // Only MessageListener declares .Retry/.DLQ. EventListener does not,
        // so a failed event has nowhere durable to land.
        expect(dlqExists).toBe(false);
    });

    it('does NOT stall the consumer', () => {
        // The prefetch is 1 by default and five handlers failed, so a message
        // left unacknowledged would have blocked everything behind it. The
        // reject is what keeps the consumer alive.
        expect(succeeded).toEqual(['good-1']);
        expect(queueAfter.consumerCount).toBe(1);
    });
});
