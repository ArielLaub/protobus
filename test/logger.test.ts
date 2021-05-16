import { expect } from 'chai';
import { Logger, ILogger, set as setLogger, DefaultLogger } from '../lib/logger';

describe('Logger tests suite', () => {
    it('should override logger', async () => {
        const result = await new Promise(async (resolve) => {
            const testLogger: ILogger = {
                info: (message) => { resolve(message); },
                debug: (message) => {},
                warn: (message) => {},
                error: (message) => {}
            };
            setLogger(testLogger);
            Logger.info('test message');
        });
        expect(result).to.equal('test message');
    });

    after(() => {
        setLogger(new DefaultLogger());
    });
});

