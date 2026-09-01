"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.boot = boot;
const protobus_1 = require("protobus");
// after — one service per process
class OrdersService extends protobus_1.RunnableService {
    get ServiceName() { return 'Orders.Service'; }
}
async function boot(context) {
    await protobus_1.RunnableService.start(context, OrdersService, { maxConcurrent: 2 });
}
