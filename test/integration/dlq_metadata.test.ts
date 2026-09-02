import * as amqplib from 'amqplib';
import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';

/**
 * What an operator actually reads off a dead-lettered message.
 *
 * These three claims are only observable on the wire, which is why they are
 * asserted against a real broker rather than against the classes:
 *
 * - `x-last-error` must name the error's CLASS. `safeErrorSummary` reads
 *   `err.name` first, and a class declared as `class Foo extends Error {}`
 *   leaves that as the inherited literal `'Error'` — so a whole family of
 *   distinct failures arrived in the DLQ indistinguishable from one another.
 * - `contentType` must survive the hop. The retry and DLQ publishes build
 *   their properties by hand, and anything not copied is silently dropped.
 * - `messageId` must be the one the CALLER chose, unchanged across the retry
 *   hop, since that is the whole point of being able to set it.
 */

const proto = `syntax = "proto3";
package AuditWire;

message Request { string action = 1; }
message Response { string result = 1; }

service Service {
    rpc slowMethod(AuditWire.Request) returns(AuditWire.Response);
}`;

const AMQP = 'amqp://guest:guest@localhost:5672/';
// Unique per run so parallel runs do not compete for one queue, and so the
// queues this suite creates are the only ones it deletes.
const SERVICE = `AuditWire.Service.run${Date.now()}`;

class SlowService extends MessageService {
    constructor(context: IContext) {
        super(context, {
            // Shorter than the handler, so the connection layer's own
            // TimeoutError is what fails the delivery.
            processingTimeoutMs: 150,
            retry: { maxRetries: 1, retryDelayMs: 100 },
        });
    }
    public get ServiceName(): string { return SERVICE; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }

    public async slowMethod(): Promise<any> {
        await new Promise(resolve => setTimeout(resolve, 3000));
        return { result: 'too late' };
    }
}

describe('dead-letter metadata', () => {
    let context: Context;
    let dlqMessage: amqplib.GetMessage | false;
    const CALLER_MESSAGE_ID = `audit-wire-${Date.now()}`;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP, []);
        context.factory.parse(proto, 'AuditWire.Service');

        const service = new SlowService(context);
        await service.init();

        const client: any = new ServiceProxy(context, SERVICE);
        await client.init();

        // Fails, is retried once, then dead-letters. The caller gets nothing
        // back — a processing timeout carries no pre-encoded error response —
        // so a short call timeout keeps the suite quick.
        await expect(
            client.slowMethod({ action: 'hang' }, undefined, true, 2500, { messageId: CALLER_MESSAGE_ID }),
        ).rejects.toThrow();

        // Polled rather than slept on. The DLQ hop lands some time after the
        // second failure, and a fixed wait is the usual first thing to break
        // on a loaded CI box — too short and the suite fails for a reason that
        // has nothing to do with what it asserts.
        const raw = await amqplib.connect(AMQP);
        const ch = await raw.createChannel();
        const deadline = Date.now() + 15000;
        dlqMessage = false;
        while (Date.now() < deadline) {
            dlqMessage = await ch.get(`${SERVICE}.DLQ`, { noAck: true });
            if (dlqMessage !== false) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await ch.close();
        await raw.close();
    }, 30000);

    afterAll(async () => {
        // Only the queues this suite created.
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

    it('the message reached the DLQ at all', () => {
        expect(dlqMessage).not.toBe(false);
    });

    it('x-last-error names the error class, not the literal string Error', () => {
        const headers = (dlqMessage as amqplib.GetMessage).properties.headers!;
        const lastError = String(headers['x-last-error']);
        expect(lastError).toContain('TimeoutError');
        expect(lastError).not.toBe('Error');
    });

    it('keeps the content type across the retry and DLQ hops', () => {
        expect((dlqMessage as amqplib.GetMessage).properties.contentType)
            .toBe('application/octet-stream');
    });

    it('keeps the caller supplied messageId across the retry and DLQ hops', () => {
        expect((dlqMessage as amqplib.GetMessage).properties.messageId).toBe(CALLER_MESSAGE_ID);
    });

    it('records the retry history an operator needs', () => {
        const headers = (dlqMessage as amqplib.GetMessage).properties.headers!;
        expect(headers['x-original-queue']).toBe(SERVICE);
        expect(String(headers['x-original-routing-key'])).toContain(SERVICE);
        expect(headers['x-retry-count']).toBe(1);
    });
});
