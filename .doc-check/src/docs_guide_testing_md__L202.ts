import * as amqplib from 'amqplib';

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';

/** Delete a service's queues so a re-run is not blocked by stale arguments. */
export async function cleanupQueues(names: string[]): Promise<void> {
    const conn = await amqplib.connect(AMQP_URL);
    for (const name of names) {
        // A failed delete kills the channel, so use one channel per queue.
        const ch = await conn.createChannel();
        ch.on('error', () => undefined);
        try { await ch.deleteQueue(name); } catch { /* already gone */ }
        try { await ch.close(); } catch { /* channel died on the delete */ }
    }
    await conn.close();
}
