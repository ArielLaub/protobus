import Config from '../../lib/config';
import { applyHeartbeat } from '../../lib/connection';

describe('heartbeat configuration', () => {
    const saved = process.env.AMQP_HEARTBEAT_SECONDS;
    afterEach(() => {
        if (saved === undefined) { delete process.env.AMQP_HEARTBEAT_SECONDS; }
        else { process.env.AMQP_HEARTBEAT_SECONDS = saved; }
    });

    it('defaults to an interval that detects a dead peer in tens of seconds', () => {
        delete process.env.AMQP_HEARTBEAT_SECONDS;
        expect(Config.heartbeatSeconds).toBe(30);
    });

    it('is settable from the environment', () => {
        process.env.AMQP_HEARTBEAT_SECONDS = '5';
        expect(Config.heartbeatSeconds).toBe(5);
    });

    it('applies the configured interval to a url that does not set one', () => {
        delete process.env.AMQP_HEARTBEAT_SECONDS;
        expect(applyHeartbeat('amqp://guest:guest@localhost:5672/'))
            .toBe('amqp://guest:guest@localhost:5672/?heartbeat=30');
    });

    it('leaves an explicit heartbeat alone, including zero', () => {
        process.env.AMQP_HEARTBEAT_SECONDS = '30';
        expect(applyHeartbeat('amqp://h:5672/vh?heartbeat=7')).toBe('amqp://h:5672/vh?heartbeat=7');
        expect(applyHeartbeat('amqp://h:5672/vh?heartbeat=0')).toBe('amqp://h:5672/vh?heartbeat=0');
    });

    it('preserves a percent-encoded vhost and any other parameters', () => {
        process.env.AMQP_HEARTBEAT_SECONDS = '15';
        expect(applyHeartbeat('amqp://u:p%40ss@host:5672/%2f'))
            .toBe('amqp://u:p%40ss@host:5672/%2f?heartbeat=15');
        expect(applyHeartbeat('amqps://u:p@host/vh?frameMax=8192'))
            .toBe('amqps://u:p@host/vh?frameMax=8192&heartbeat=15');
    });

    it('hands an unparseable url straight to amqplib', () => {
        expect(applyHeartbeat('not a url')).toBe('not a url');
    });
});
