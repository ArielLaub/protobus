import { EventEmitter } from 'events';

import MessageListener from '../../lib/message_listener';
import MessageDispatcher, { StreamOptions } from '../../lib/message_dispatcher';
import MessageService from '../../lib/message_service';
import MessageFactory from '../../lib/message_factory';
import Config from '../../lib/config';
import { InvalidPriorityError } from '../../lib/priority';

/**
 * A connection stub that records the arguments of every queue declaration and
 * every publish.
 *
 * The queue-argument recording is the point of most of this file. RabbitMQ
 * fixes a queue's arguments at declare time, so a queue that gains an
 * `x-max-priority` it did not have before is a 406 PRECONDITION_FAILED that
 * closes the channel — and protobus shares one connection across every
 * listener, so that is a service-wide outage on upgrade. The guarantee under
 * test is therefore not "priority works" but "a listener that did not ask for
 * priority declares byte-identical arguments to the version before it".
 */
class RecordingConnection extends EventEmitter {
    public isConnected = true;
    public isReconnecting = false;
    public declaredQueues: Array<{ name: string; options: any }> = [];
    public published: Array<{
        exchange: string; routingKey: string; content: Buffer; properties: any;
    }> = [];

    async openChannel(): Promise<any> {
        return {
            prefetch: async () => undefined,
            consume: async () => ({ consumerTag: 'tag' }),
            close: async () => undefined,
            publish: () => true,
        };
    }
    async closeChannel() { return undefined; }
    async declareExchange() { return undefined; }
    async declareQueue(_ch: any, name: string, options: any) {
        this.declaredQueues.push({ name, options });
        return name || 'anonymous.queue';
    }
    async bindQueue() { return undefined; }
    async unbindQueue() { return undefined; }
    async deleteQueue() { return undefined; }
    async ack() { return undefined; }
    async reject() { return undefined; }
    async consume() { return { consumerTag: 'tag' }; }
    async cancel() { return undefined; }
    async purgeQueue() { return undefined; }
    async publish(
        _ch: any, exchange: string, routingKey: string, content: Buffer, properties: any,
    ) {
        this.published.push({ exchange, routingKey, content, properties });
    }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }

    /** The arguments the named queue was declared with, most recent declare. */
    argsFor(name: string): Record<string, unknown> | undefined {
        const hits = this.declaredQueues.filter(q => q.name === name);
        return hits.length ? hits[hits.length - 1].options.arguments : undefined;
    }
}

const NO_RETRY = { maxRetries: 0, retryDelayMs: 5000 };

describe('queue declaration is unchanged unless maxPriority is asked for', () => {
    it('declares an empty arguments object when maxPriority is not set', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(conn as any, true, 1, NO_RETRY);
        await listener.init(async () => undefined, 'Svc');

        // toEqual, not a key-by-key check: the whole object has to match what
        // the previous version sent, or an existing queue cannot be redeclared.
        expect(conn.argsFor('Svc')).toEqual({});
        expect(Object.prototype.hasOwnProperty.call(conn.argsFor('Svc'), 'x-max-priority'))
            .toBe(false);
    });

    it('leaves a TTL-only arguments object alone when maxPriority is not set', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(
            conn as any, true, 1, { maxRetries: 0, retryDelayMs: 5000, messageTtlMs: 60000 },
        );
        await listener.init(async () => undefined, 'Svc');

        expect(conn.argsFor('Svc')).toEqual({ 'x-message-ttl': 60000 });
    });

    it('declares x-max-priority when maxPriority is set', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(conn as any, true, 1, NO_RETRY, undefined, 2);
        await listener.init(async () => undefined, 'Svc');

        expect(conn.argsFor('Svc')).toEqual({ 'x-max-priority': 2 });
    });

    it('declares x-max-priority alongside a message TTL', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(
            conn as any, true, 1,
            { maxRetries: 0, retryDelayMs: 5000, messageTtlMs: 60000 },
            undefined, 2,
        );
        await listener.init(async () => undefined, 'Svc');

        expect(conn.argsFor('Svc')).toEqual({ 'x-message-ttl': 60000, 'x-max-priority': 2 });
    });

    /**
     * The reconnection path declares the queue a SECOND time, from its own copy
     * of the argument-building code. A queue declared with x-max-priority on
     * startup and without it after a broker restart is a 406 that leaves the
     * listener dead behind a connection reporting itself healthy — the exact
     * failure mode this option exists to avoid causing.
     */
    it('declares the same x-max-priority on the reconnection path', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(conn as any, true, 1, NO_RETRY, undefined, 2);
        await listener.init(async () => undefined, 'Svc');
        conn.declaredQueues.length = 0;

        await (listener as any)._reinitialize();

        expect(conn.argsFor('Svc')).toEqual({ 'x-max-priority': 2 });
    });

    it('declares no x-max-priority on the reconnection path when unset', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(conn as any, true, 1, NO_RETRY);
        await listener.init(async () => undefined, 'Svc');
        conn.declaredQueues.length = 0;

        await (listener as any)._reinitialize();

        expect(conn.argsFor('Svc')).toEqual({});
    });

    /**
     * Deliberately NOT propagated to the retry queue or the DLQ. Dead-lettering
     * preserves a message's priority property (verified against RabbitMQ 3), so
     * a retried message re-sorts correctly when it lands back in the main
     * priority queue without the retry queue needing priority of its own — and
     * keeping those two queues untouched makes enabling the option a ONE-queue
     * migration rather than a three-queue one.
     */
    it('leaves the retry queue and DLQ arguments untouched', async () => {
        const conn = new RecordingConnection();
        const listener = new MessageListener(
            conn as any, true, 1, { maxRetries: 3, retryDelayMs: 5000 }, undefined, 2,
        );
        await listener.init(async () => undefined, 'Svc');
        await listener.subscribe('REQUEST.Svc.*');

        expect(conn.argsFor('Svc.DLQ')).toEqual({});
        expect(conn.argsFor('Svc.Retry')).toEqual({
            'x-message-ttl': 5000,
            'x-dead-letter-exchange': Config.busExchangeName,
        });
    });
});

describe('maxPriority validation', () => {
    const build = (v: any) => () => new MessageListener(
        new RecordingConnection() as any, true, 1, NO_RETRY, undefined, v,
    );

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['above the AMQP maximum', 256],
        ['non-integer', 1.5],
        ['a string', '2'],
        ['NaN', NaN],
        ['null', null],
        // Explicit because protobus-py has to reject it explicitly:
        // isinstance(True, int) is True in Python, so max_priority=True would
        // silently mean 1 there. TS rejects it via the typeof check, and this
        // pins that the two ports agree.
        ['a boolean', true],
    ])('rejects %s', (_label, value) => {
        expect(build(value)).toThrow(InvalidPriorityError);
    });

    it.each([[1], [2], [10], [255]])('accepts %i', (value) => {
        expect(build(value)).not.toThrow();
    });

    it('accepts undefined, which is what leaves the queue arguments alone', () => {
        expect(build(undefined)).not.toThrow();
    });
});

describe('per-message priority on the publish path', () => {
    it('sets no priority property at all when none is asked for', async () => {
        const conn = new RecordingConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        await d.publish(Buffer.from('x'), 'REQUEST.A.B.c', false);

        const props = conn.published[0].properties;
        // Absent, not `undefined`: the guarantee is a byte-identical publish.
        expect(Object.prototype.hasOwnProperty.call(props, 'priority')).toBe(false);
    });

    it('sets the priority property on a fire-and-forget publish', async () => {
        const conn = new RecordingConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        await d.publish(Buffer.from('x'), 'REQUEST.A.B.c', false, undefined, { priority: 2 });

        expect(conn.published[0].properties.priority).toBe(2);
    });

    it('sets the priority property on an RPC publish', async () => {
        const conn = new RecordingConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const pending = d.publish(
            Buffer.from('x'), 'REQUEST.A.B.c', true, 50, { priority: 2 },
        );
        pending.catch(() => undefined); // never answered; the timeout is not what is under test
        await new Promise(r => setTimeout(r, 25));

        expect(conn.published[0].properties.priority).toBe(2);
    });

    /**
     * PRIORITY_NORMAL is 0, and 0 is falsy. A `if (options.priority)` guard
     * would drop it, which is silently wrong rather than loudly wrong: the
     * message still publishes, just without the property the caller set.
     */
    it('sends an explicit priority of 0 rather than treating it as unset', async () => {
        const conn = new RecordingConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        await d.publish(
            Buffer.from('x'), 'REQUEST.A.B.c', false, undefined,
            { priority: Config.PRIORITY_NORMAL },
        );

        const props = conn.published[0].properties;
        expect(Object.prototype.hasOwnProperty.call(props, 'priority')).toBe(true);
        expect(props.priority).toBe(0);
    });
});

describe('per-message priority validation', () => {
    async function publishWith(priority: any) {
        const conn = new RecordingConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();
        return d.publish(Buffer.from('x'), 'REQUEST.A.B.c', false, undefined, { priority });
    }

    it.each([
        ['negative', -1],
        ['above the AMQP maximum', 256],
        // amqplib does not reject this one: it truncates 1.5 to 1 on the wire
        // (verified against RabbitMQ 3). Silent truncation is the reason this
        // is validated here rather than left to the driver.
        ['non-integer', 1.5],
        ['a string', 'high'],
        ['NaN', NaN],
        ['a boolean', true],
    ])('rejects %s', async (_label, value) => {
        await expect(publishWith(value)).rejects.toBeInstanceOf(InvalidPriorityError);
    });

    it.each([[0], [1], [2], [255]])('accepts %i', async (value) => {
        await expect(publishWith(value)).resolves.toBeUndefined();
    });
});

describe('priority constants', () => {
    it('names the three levels the recommended queue depth provides', () => {
        expect(Config.PRIORITY_NORMAL).toBe(0);
        expect(Config.PRIORITY_HIGH).toBe(1);
        expect(Config.PRIORITY_CONTROL).toBe(2);
        expect(Config.RECOMMENDED_MAX_PRIORITY).toBe(2);
    });

    it('keeps the recommended maximum small', () => {
        // RabbitMQ builds internal structures per level. The docs recommend a
        // handful; 255 is legal and a waste of memory and throughput.
        expect(Config.RECOMMENDED_MAX_PRIORITY).toBeLessThanOrEqual(5);
    });
});

describe('MessageService threads maxPriority to its request listener', () => {
    class Svc extends MessageService {
        public get ServiceName() { return 'Test.Svc'; }
        public get ProtoFileName() { return 'unused.proto'; }
    }

    function context(conn: RecordingConnection): any {
        return { connection: conn, factory: new MessageFactory() };
    }

    /**
     * White-box on purpose. The alternative — standing the service up against a
     * broker — is the integration suite's job; what this pins is only that the
     * option is not silently dropped between IMessageServiceOptions and the
     * listener that actually declares the queue.
     */
    it('passes maxPriority through to the listener', () => {
        const conn = new RecordingConnection();
        const svc = new Svc(context(conn), { maxPriority: 2 });
        expect((svc as any).listener.maxPriority).toBe(2);
    });

    it('leaves the listener without a maxPriority when the option is omitted', () => {
        const conn = new RecordingConnection();
        const svc = new Svc(context(conn), {});
        expect((svc as any).listener.maxPriority).toBeUndefined();
    });

    it('rejects an out-of-range maxPriority at construction, before any broker I/O', () => {
        const conn = new RecordingConnection();
        expect(() => new Svc(context(conn), { maxPriority: 256 })).toThrow(InvalidPriorityError);
    });

    it('does not give the events listener a priority queue', () => {
        // Events are explicitly out of scope: the request queue is where
        // control traffic gets stuck behind bulk fan-out.
        const conn = new RecordingConnection();
        const svc = new Svc(context(conn), { maxPriority: 2 });
        expect((svc as any).eventListener.maxPriority).toBeUndefined();
    });
});

describe('streaming calls cannot carry a priority', () => {
    /**
     * A type-level assertion. StreamOptions occupies the 4th argument slot
     * where a unary call takes CallOptions, so `{priority}` on a streaming call
     * is an easy mistake the broker would never complain about — the property
     * is simply never sent.
     *
     * Deliberately NOT an object literal. TypeScript's excess-property check
     * already rejects `const o: StreamOptions = { priority: 2 }` whether or not
     * `priority?: never` exists, so a literal-based test passes for the wrong
     * reason — verified by removing the declaration and watching the literal
     * version stay green. Excess-property checking does not apply to a value
     * that arrives through a variable, and that is the case `priority?: never`
     * actually rules out.
     *
     * `@ts-expect-error` is the oracle in both directions: ts-jest fails the
     * suite on an UNUSED directive, so dropping `priority?: never` turns this
     * red rather than silently green.
     */
    it('rejects a priority reaching StreamOptions through a variable', () => {
        const carrier = { signal: new AbortController().signal, priority: 2 };
        // @ts-expect-error priority is not supported on a streaming call
        const bad: StreamOptions = carrier;
        expect(bad).toBeDefined();

        const good: StreamOptions = { signal: new AbortController().signal };
        expect(good.signal).toBeDefined();
    });
});
