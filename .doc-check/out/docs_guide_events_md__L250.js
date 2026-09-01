"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class ReportingService extends protobus_1.RunnableService {
    get ServiceName() { return 'Reporting.Service'; }
    async init() {
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.store(event);
        });
        // Same topic. Both handlers run for every delivery.
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.countIt(event);
        });
    }
    async store(_event) { }
    async countIt(_event) { }
}
