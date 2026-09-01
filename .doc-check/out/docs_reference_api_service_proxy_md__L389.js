"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderService = void 0;
const protobus_1 = require("protobus");
class OrderService extends protobus_1.MessageService {
    payments;
    get ServiceName() { return 'Orders.Service'; }
    get ProtoFileName() { return __dirname + '/proto/Orders.proto'; }
    constructor(context) {
        super(context, { maxConcurrent: 10 });
        this.payments = new protobus_1.ServiceProxy(context, 'Payments.Service');
    }
    async init() {
        await super.init();
        await this.payments.init();
    }
    async create(request) {
        await this.payments.charge({ amount: request.total });
        return { orderId: 'o-1' };
    }
}
exports.OrderService = OrderService;
