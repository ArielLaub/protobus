"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrdersService = void 0;
const protobus_1 = require("protobus");
class OrdersService extends protobus_1.RunnableService {
    get ServiceName() { return 'Orders.Service'; }
    constructor(context) {
        super(context, {
            maxConcurrent: 4,
            retry: {
                maxRetries: 5, // default 3
                retryDelayMs: 2000, // default 5000
            },
        });
    }
}
exports.OrdersService = OrdersService;
