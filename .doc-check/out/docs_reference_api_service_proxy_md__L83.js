"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function connect(context) {
    const assistant = new protobus_1.ServiceProxy(context, 'Chat.Assistant');
    await assistant.init();
    return assistant;
}
