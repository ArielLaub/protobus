import { Logger, ILogger, set as setLogger, DefaultLogger } from '../../lib/logger';

describe('Logger tests suite', () => {
    afterAll(() => {
        setLogger(new DefaultLogger());
    });

    it('should override logger', async () => {
        const result = await new Promise(async (resolve) => {
            const testLogger: ILogger = {
                info: (message) => { resolve(message); },
                debug: (_message) => {},
                warn: (_message) => {},
                error: (_message) => {}
            };
            setLogger(testLogger);
            Logger.info('test message');
        });
        expect(result).toBe('test message');
    });
});
