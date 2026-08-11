import { IConnection, Channel } from './connection';
import Config from './config';
import { Logger } from './logger';

/**
 * Listens for stream-cancellation notices and stops the matching in-flight
 * stream in this process.
 *
 * Deliberately NOT a BaseListener. It needs its own channel and an unbounded
 * prefetch: the whole point is to be heard while the service is busy inside a
 * streaming handler, and BaseListener's request-serving machinery (retry
 * queues, DLQ, late ack, prefetch of 1) would make it queue behind exactly the
 * work it is meant to interrupt.
 *
 * The queue is exclusive and auto-delete, so each replica has its own and the
 * broker cleans it up when the process goes away. Cancels are consumed with
 * noAck — a lost cancel means the stream runs on, which is the same outcome as
 * never having sent one, and redelivering a cancel for a finished stream would
 * be pointless.
 */
export default class CancelListener {
    private connection: IConnection;
    private channel: Channel | undefined;
    private queueName = '';
    private consumerTag = '';
    private _boundOnReconnected: () => void;

    constructor(connection: IConnection) {
        this.connection = connection;
        this._boundOnReconnected = this._onReconnected.bind(this);
        this.connection.on('reconnected', this._boundOnReconnected);
    }

    /**
     * Best effort by design: a deployment whose broker credentials cannot
     * declare the cancel exchange keeps working without cancellation support
     * rather than failing to start.
     */
    async start(): Promise<void> {
        try {
            await this._start();
        } catch (err: any) {
            Logger.warn(
                `CancelListener: stream cancellation unavailable (${err?.message || err}). ` +
                'Streams will run to completion; everything else is unaffected.',
            );
            this.channel = undefined;
        }
    }

    private async _start(): Promise<void> {
        this.channel = await this.connection.openChannel();
        await this.connection.declareExchange(
            this.channel, Config.cancelExchangeName, 'fanout',
            { durable: true, autoDelete: false, internal: false, arguments: {} },
        );

        // Anonymous queue: the broker names it, this process owns it, and it
        // disappears with the connection.
        this.queueName = await this.connection.declareQueue(this.channel, '', {
            exclusive: true,
            autoDelete: true,
            durable: false,
        });
        await this.connection.bindQueue(
            this.channel, this.queueName, Config.cancelExchangeName, '', {},
        );
        const result = await this.channel.consume(this.queueName, (msg) => {
            if (!msg) return;
            const correlationId = msg.properties?.correlationId;
            if (!correlationId) return;

            // Every replica sees every cancel; only the one running that stream
            // has anything to do.
            this.connection.cancelStream?.(correlationId);
        }, { noAck: true });

        this.consumerTag = result?.consumerTag || '';
        Logger.debug(`CancelListener: consuming cancellations on ${this.queueName}`);
    }

    private async _onReconnected(): Promise<void> {
        if (!this.channel && !this.queueName) return;
        try {
            await this.start();
            Logger.debug('CancelListener: re-established after reconnection');
        } catch (err: any) {
            Logger.error(`CancelListener: failed to re-establish after reconnection: ${err?.message || err}`);
        }
    }

    async close(): Promise<void> {
        this.connection.removeListener('reconnected', this._boundOnReconnected);

        if (this.channel && this.connection.isConnected) {
            try {
                if (this.consumerTag) {
                    await this.connection.cancel(this.channel, this.consumerTag);
                }
                await this.connection.closeChannel(this.channel);
            } catch (err: any) {
                Logger.debug(`CancelListener: error during close: ${err?.message || err}`);
            }
        }

        this.channel = undefined;
        this.consumerTag = '';
        this.queueName = '';
    }
}
