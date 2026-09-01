"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderProjection = void 0;
const protobus_1 = require("protobus");
class OrderProjection extends protobus_1.RunnableService {
    get ServiceName() { return 'Orders.Projection'; }
    async init() {
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.project(event);
            }
            catch (error) {
                // Nothing downstream will retry this. Persist enough to
                // reprocess deliberately, and do not rethrow expecting a requeue.
                await this.recordFailure(event, error);
            }
        });
    }
    async project(_event) { }
    async recordFailure(_event, _error) { }
}
exports.OrderProjection = OrderProjection;
