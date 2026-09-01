import { Context, ReconnectionError } from 'protobus';

async function main() {
    const context = new Context();

    try {
        await context.init(process.env.AMQP_URL || 'amqp://localhost', ['./proto/']);
    } catch (error: any) {
        if (error?.code === 'ECONNREFUSED') {
            console.error('RabbitMQ is not reachable');
        } else if (error instanceof ReconnectionError) {
            console.error('gave up reconnecting');
        } else {
            console.error(`schema or broker setup failed: ${error?.message}`);
        }
        process.exit(1);
    }
}
