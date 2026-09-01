import { Context } from 'protobus';

async function main() {
    const context = new Context();

    await context.init(
        process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/',
        [__dirname + '/proto/'],
        {
            reconnection: {
                maxRetries: 0,          // 0 means keep retrying forever
                initialDelayMs: 500,
                maxDelayMs: 10000,
                backoffMultiplier: 2,
            },
        },
    );
}
