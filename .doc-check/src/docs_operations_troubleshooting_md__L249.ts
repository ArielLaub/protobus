import { Context } from 'protobus';

async function main() {
    const context = new Context();

    await context.init('amqp://localhost', ['./proto'], {
        reconnection: {
            maxRetries: 0,        // 0 = keep trying forever
            maxDelayMs: 30000,
        },
    });

    context.connection.on('disconnected', () => console.warn('connection lost'));
    context.connection.on('reconnected', () => console.info('connection restored'));
}

main().catch((error) => { console.error(error); process.exit(1); });
