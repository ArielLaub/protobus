import Config from './config';
import { BaseListener } from './base_listener';
import { IConnection } from './connection';

export default class CallbackListener extends BaseListener {
    constructor(connection: IConnection) {
        super(connection);

        this.exchangeName = Config.callbacksExchangeName;
        this.exchangeType = 'direct';
    }

    get callbackQueue() { return this.queueName; }
}
