"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class BillingService extends protobus_1.RunnableService {
    get ServiceName() { return 'Billing.Service'; }
    async init() {
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.charge(event);
            }
            catch (error) {
                // Nothing above this line will retry, so failure has to be
                // recorded here or it is recorded nowhere.
                await this.parkForReplay(event, error);
            }
        });
    }
    async charge(_event) { }
    async parkForReplay(_event, _error) { }
}
