"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Clients = void 0;
const protobus_1 = require("protobus");
class Clients {
    users;
    orders;
    constructor(context) {
        this.users = new protobus_1.ServiceProxy(context, 'Users.Service');
        this.orders = new protobus_1.ServiceProxy(context, 'Orders.Service');
    }
    async init() {
        // They share one context, so one connection and one callback queue.
        await Promise.all([this.users.init(), this.orders.init()]);
    }
}
exports.Clients = Clients;
