import * as amqplib from 'amqplib';

import Connection from '../../lib/connection';
import { redactUrl, ILogger, set as setLogger, DefaultLogger } from '../../lib/logger';

// amqplib's exports are non-configurable, so jest.spyOn cannot wrap connect().
jest.mock('amqplib', () => ({ connect: jest.fn() }));

describe('redactUrl', () => {
    it('replaces the password but keeps the rest of the URL useful', () => {
        expect(redactUrl('amqp://user:s3cret@rabbit:5672/vhost'))
            .toBe('amqp://user:***@rabbit:5672/vhost');
    });

    it('preserves an encoded vhost', () => {
        expect(redactUrl('amqp://user:s3cret@rabbit:5672/%2f'))
            .toBe('amqp://user:***@rabbit:5672/%2f');
    });

    it('leaves a credential-free URL alone', () => {
        expect(redactUrl('amqp://localhost')).toBe('amqp://localhost');
    });

    it('redacts anything that does not parse as a URL', () => {
        expect(redactUrl('not a url')).toBe('<redacted>');
    });
});

describe('Connection', () => {
    afterAll(() => {
        setLogger(new DefaultLogger());
        jest.restoreAllMocks();
    });

    it('never logs the password when connecting', async () => {
        const lines: string[] = [];
        const capturing: ILogger = {
            info: (m) => { lines.push(String(m)); },
            debug: (m) => { lines.push(String(m)); },
            warn: (m) => { lines.push(String(m)); },
            error: (m) => { lines.push(String(m)); },
        };
        setLogger(capturing);

        const handle = { on: () => {}, close: async () => {} };
        (amqplib.connect as jest.Mock).mockResolvedValue(handle);

        const connection = new Connection();
        await connection.connect('amqp://user:s3cret@rabbit:5672/vhost');

        expect(lines.join('\n')).not.toContain('s3cret');
        expect(lines.some((l) => l.includes('amqp://user:***@rabbit:5672/vhost'))).toBe(true);

        // The real URL still has to reach amqplib untouched.
        expect(amqplib.connect).toHaveBeenCalledWith('amqp://user:s3cret@rabbit:5672/vhost');
    });
});
