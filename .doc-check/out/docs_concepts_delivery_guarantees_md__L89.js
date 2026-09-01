"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
const alreadyDone = new Set();
class OrdersService extends protobus_1.MessageService {
    get ServiceName() { return 'Orders.Service'; }
    get ProtoFileName() { return './protos/orders.proto'; }
    async create(request, actor, correlationId, ctx) {
        // messageId is stable across every redelivery and every retry hop.
        const key = ctx?.messageId;
        if (key && alreadyDone.has(key)) {
            return { ok: true }; // already applied; do not charge the card twice
        }
        if (key) {
            alreadyDone.add(key);
        }
        return { ok: true };
    }
}
