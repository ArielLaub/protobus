import { Context } from 'protobus';

async function main() {
    const context = new Context();
    // The schema is in the root before any service asks for it, so the
    // convention-derived filename is never read from disk.
    await context.init('amqp://localhost', [__dirname + '/proto/']);
}
