import { BaseListener } from './base_listener';
import Config from './config';
import { IConnection } from './connection';

export default class MessageListener extends BaseListener {
    constructor(connection: IConnection, lateAck?: boolean, maxConcurrent?: number) {
        super(connection);

        this.exchangeName = Config.busExchangeName;
        this.exchangeType = 'topic';

        this.lateAck = !!lateAck;
        this.maxConcurrent = maxConcurrent || 1;
    }

    async subscribe(topics: string[] | string) {
        if (typeof topics === 'string') { topics = [topics]; }

        await topics.map((topic: string) => {
            return this.connection.bindQueue(this.channel, this.queueName, this.exchangeName, topic, {});
        });
    }
}
