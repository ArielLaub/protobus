"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoneyType = void 0;
exports.start = start;
const protobus_1 = require("protobus");
exports.MoneyType = {
    name: 'money', // the token that appears in the .proto
    wireType: 'string', // how it is actually encoded
    tsType: 'Money', // what `protobus generate` writes into the .d.ts
    encode: (value) => `${value.currency}:${value.cents}`,
    decode: (data) => {
        const [currency, cents] = String(data).split(':');
        return { currency, cents: Number(cents) };
    },
};
async function start() {
    const context = new protobus_1.Context();
    context.factory.registerType(exports.MoneyType); // BEFORE init, see below
    await context.init('amqp://guest:guest@localhost:5672/', ['./proto']);
    return context;
}
