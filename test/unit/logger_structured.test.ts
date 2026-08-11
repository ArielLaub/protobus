import {
    Log,
    Logger,
    LogLevel,
    LogRecord,
    IStructuredLogger,
    DefaultLogger,
    formatLogRecord,
    setDiagnosticsSerializer,
    set as setLogger,
    setLevel,
    getLevel,
} from '../../lib/logger';

/**
 * The audit asks for framework log lines to be emitable as structured records
 * with a fixed, safe field set: never connection URLs, raw headers, payloads,
 * decoded protobuf values or arbitrary broker error strings by default, and an
 * opt-in hook for users who do want payload diagnostics.
 *
 * The tests below pin both halves: what the envelope carries, and what it
 * refuses to carry unless the user asks for it.
 */

const SECRET = 'MARKER-4b91-do-not-log';

/** Collects records; also collects strings so a leak cannot hide in the fallback. */
class CapturingStructuredLogger implements IStructuredLogger {
    public records: LogRecord[] = [];
    public lines: string[] = [];
    log(record: LogRecord) { this.records.push(record); }
    info(m: any) { this.lines.push(String(m)); }
    warn(m: any) { this.lines.push(String(m)); }
    debug(m: any) { this.lines.push(String(m)); }
    error(m: any) { this.lines.push(String(m)); }
    get text() { return this.lines.join('\n') + '\n' + JSON.stringify(this.records); }
}

describe('structured log envelope', () => {
    const original = getLevel();
    let structured: CapturingStructuredLogger;

    beforeEach(() => {
        structured = new CapturingStructuredLogger();
        setLogger(structured);
        setLevel(LogLevel.Info);
        setDiagnosticsSerializer(null);
    });

    afterEach(() => {
        setDiagnosticsSerializer(null);
        setLevel(original);
        setLogger(new DefaultLogger());
    });

    it('delivers a record to a sink that implements log()', () => {
        Log.info('published request', {
            operation: 'publish',
            messageType: 'example.Service.DoThing',
            messageId: 'mid-1',
            correlationId: 'cid-1',
            sizeBytes: 1234,
            outcome: 'confirmed',
        });

        expect(structured.records).toHaveLength(1);
        expect(structured.records[0]).toMatchObject({
            component: 'protobus',
            level: 'info',
            operation: 'publish',
            message: 'published request',
            messageType: 'example.Service.DoThing',
            messageId: 'mid-1',
            correlationId: 'cid-1',
            sizeBytes: 1234,
            outcome: 'confirmed',
        });
        expect(typeof structured.records[0].timestamp).toBe('string');
        expect(Number.isNaN(Date.parse(structured.records[0].timestamp))).toBe(false);
        // A structured sink gets the record only; no duplicate string line.
        expect(structured.lines).toEqual([]);
    });

    it('stamps component itself so fields cannot forge it', () => {
        Log.warn('unroutable', { operation: 'publish', component: 'not-protobus' } as any);
        expect(structured.records[0].component).toBe('protobus');
    });

    it('falls back to the string path for a sink without log()', () => {
        const lines: string[] = [];
        setLogger({
            info: (m: any) => lines.push(`info:${m}`),
            warn: (m: any) => lines.push(`warn:${m}`),
            debug: (m: any) => lines.push(`debug:${m}`),
            error: (m: any) => lines.push(`error:${m}`),
        });

        Log.warn('nacked by broker', {
            operation: 'publish',
            messageType: 'example.Service.DoThing',
            correlationId: 'cid-2',
            outcome: 'failed',
        });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('warn:');
        expect(lines[0]).toContain('protobus');
        expect(lines[0]).toContain('publish');
        expect(lines[0]).toContain('nacked by broker');
        expect(lines[0]).toContain('correlationId=cid-2');
        expect(lines[0]).toContain('outcome=failed');
    });

    it('routes each level to the matching string method', () => {
        const seen: string[] = [];
        setLogger({
            info: () => seen.push('info'),
            warn: () => seen.push('warn'),
            debug: () => seen.push('debug'),
            error: () => seen.push('error'),
        });
        setLevel(LogLevel.Debug);

        Log.debug('a', { operation: 'consume' });
        Log.info('b', { operation: 'consume' });
        Log.warn('c', { operation: 'consume' });
        Log.error('d', { operation: 'consume' });

        expect(seen).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('drops fields outside the safe allowlist', () => {
        Log.error('connection failed', {
            operation: 'connect',
            correlationId: 'cid-3',
            // Exactly what the audit forbids by default.
            url: `amqp://user:${SECRET}@host/vhost`,
            headers: { authorization: SECRET },
            payload: { card: SECRET },
            body: Buffer.from(SECRET),
            brokerError: `ACCESS_REFUSED ${SECRET}`,
        } as any);

        expect(structured.text).not.toContain(SECRET);
        const record = structured.records[0] as any;
        expect(record.url).toBeUndefined();
        expect(record.headers).toBeUndefined();
        expect(record.payload).toBeUndefined();
        expect(record.body).toBeUndefined();
        expect(record.brokerError).toBeUndefined();
        expect(record.correlationId).toBe('cid-3');
    });

    it('drops non-scalar values passed in allowlisted fields', () => {
        Log.info('odd', {
            operation: 'publish',
            messageType: { toString: () => SECRET } as any,
            sizeBytes: Number.NaN,
        });

        expect(structured.text).not.toContain(SECRET);
        expect(structured.records[0].messageType).toBeUndefined();
        expect(structured.records[0].sizeBytes).toBeUndefined();
    });

    it('strips control characters and truncates long values', () => {
        Log.info(`line one\nFAKE forged line`, {
            operation: 'publish',
            messageType: 'x'.repeat(400),
        });

        const record = structured.records[0];
        expect(record.message).not.toContain('\n');
        expect(record.messageType!.length).toBeLessThanOrEqual(256);
    });

    it('applies the level filter before touching the sink', () => {
        setLevel(LogLevel.Info);
        Log.debug('payload dump', { operation: 'consume' });
        expect(structured.records).toEqual([]);

        setLevel(LogLevel.Silent);
        Log.error('boom', { operation: 'consume' });
        expect(structured.records).toEqual([]);
    });

    it('never materialises diagnostics without an installed serializer', () => {
        let asked = false;
        Log.info('handled request', {
            operation: 'consume',
            correlationId: 'cid-4',
            diagnostics: () => {
                asked = true;
                return { payload: { card: SECRET } };
            },
        });

        expect(asked).toBe(false);
        expect(structured.records[0].diagnostics).toBeUndefined();
        expect(structured.text).not.toContain(SECRET);
    });

    it('attaches whatever the opt-in serializer returns', () => {
        setDiagnosticsSerializer((diagnostics, record) => ({
            keys: Object.keys(diagnostics.payload as object),
            operation: record.operation,
        }));

        Log.info('handled request', {
            operation: 'consume',
            correlationId: 'cid-5',
            diagnostics: () => ({ payload: { card: SECRET } }),
        });

        expect(structured.records[0].diagnostics).toEqual({ keys: ['card'], operation: 'consume' });
        // The hook chose to log key names only, so the value must not appear.
        expect(structured.text).not.toContain(SECRET);
    });

    it('omits diagnostics when the serializer returns undefined', () => {
        setDiagnosticsSerializer(() => undefined);
        Log.info('handled request', { operation: 'consume', diagnostics: () => ({ payload: 1 }) });
        expect(structured.records[0].diagnostics).toBeUndefined();
    });

    it('survives a throwing serializer without losing the line', () => {
        setDiagnosticsSerializer(() => { throw new Error('hook is broken'); });

        expect(() => Log.info('handled request', {
            operation: 'consume',
            diagnostics: () => ({ payload: { card: SECRET } }),
        })).not.toThrow();

        expect(structured.records).toHaveLength(1);
        expect(structured.records[0].diagnostics).toBeUndefined();
        expect(structured.text).not.toContain(SECRET);
    });

    it('survives a throwing thunk without losing the line', () => {
        setDiagnosticsSerializer((d) => d);
        expect(() => Log.info('handled request', {
            operation: 'consume',
            diagnostics: () => { throw new Error('cannot decode'); },
        })).not.toThrow();
        expect(structured.records).toHaveLength(1);
    });

    it('degrades to the string path when the structured sink throws', () => {
        const lines: string[] = [];
        setLogger({
            log: () => { throw new Error('transport down'); },
            info: (m: any) => lines.push(String(m)),
            warn: () => undefined,
            debug: () => undefined,
            error: () => undefined,
        } as IStructuredLogger);

        expect(() => Log.info('published', { operation: 'publish', correlationId: 'cid-6' }))
            .not.toThrow();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('correlationId=cid-6');
    });

    it('formats a record deterministically', () => {
        const text = formatLogRecord({
            component: 'protobus',
            level: 'info',
            timestamp: '2026-01-01T00:00:00.000Z',
            operation: 'publish',
            message: 'published request',
            messageType: 'example.Service.DoThing',
            correlationId: 'cid-7',
            sizeBytes: 1234,
            outcome: 'confirmed',
        });

        expect(text).toBe(
            '[protobus] publish: published request '
            + '(messageType=example.Service.DoThing correlationId=cid-7 outcome=confirmed sizeBytes=1234)',
        );
    });

    it('keeps the string logger API working unchanged', () => {
        const lines: string[] = [];
        setLogger({
            info: (m: any) => lines.push(`info:${m}`),
            warn: () => undefined,
            debug: () => undefined,
            error: () => undefined,
        });

        Logger.info('plain text message');
        expect(lines).toEqual(['info:plain text message']);
    });
});
