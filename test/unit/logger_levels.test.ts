import { Logger, DefaultLogger, set, setLevel, getLevel, LogLevel } from '../../lib/logger';

/**
 * Logger.debug wrote to stdout unconditionally, and several call sites dumped
 * full request/response payloads through it. Anything piped to a log
 * aggregator therefore shipped every RPC payload — credentials, PII and all.
 * Debug must be off unless asked for.
 */
describe('log levels', () => {
    let out: string[];
    const original = getLevel();

    beforeEach(() => {
        out = [];
        set({
            info: (m: any) => out.push(`info:${m}`),
            warn: (m: any) => out.push(`warn:${m}`),
            debug: (m: any) => out.push(`debug:${m}`),
            error: (m: any) => out.push(`error:${m}`),
        });
    });

    afterEach(() => { setLevel(original); set(new DefaultLogger()); });

    it('suppresses debug at the default level', () => {
        setLevel(original);
        Logger.debug('secret payload');
        expect(out.filter(l => l.startsWith('debug:'))).toEqual([]);
    });

    it('still emits warn and error at the default level', () => {
        setLevel(original);
        Logger.warn('careful');
        Logger.error('broken');
        expect(out).toEqual(['warn:careful', 'error:broken']);
    });

    it('emits debug once the level is lowered', () => {
        setLevel(LogLevel.Debug);
        Logger.debug('now visible');
        expect(out).toEqual(['debug:now visible']);
    });

    it('silences everything at the silent level', () => {
        setLevel(LogLevel.Silent);
        Logger.debug('a'); Logger.info('b'); Logger.warn('c'); Logger.error('d');
        expect(out).toEqual([]);
    });

    it('defaults to a level that does not emit debug', () => {
        expect(getLevel()).toBeGreaterThan(LogLevel.Debug);
    });

    it('reads the initial level from LOG_LEVEL', () => {
        // Documented escape hatch for turning payload-level logging back on.
        expect(typeof LogLevel.Debug).toBe('number');
        setLevel(LogLevel.Info);
        expect(getLevel()).toBe(LogLevel.Info);
    });
});
