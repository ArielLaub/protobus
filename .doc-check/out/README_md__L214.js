"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
const UuidType = {
    name: 'uuid', // how it is written in the .proto
    wireType: 'string', // how it travels
    tsType: 'string', // what generated types call it
    encode: (value) => value,
    decode: (data) => data,
};
async function main() {
    const context = new protobus_1.Context();
    // Register before init(): init() parses your .proto files, and a schema
    // using `uuid` cannot be parsed until the type exists.
    context.factory.registerType(UuidType);
    await context.init('amqp://localhost', ['./proto']);
}
