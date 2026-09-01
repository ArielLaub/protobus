"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.quietProtobus = quietProtobus;
const protobus_1 = require("protobus");
const silent = { debug: () => { }, info: () => { }, warn: () => { }, error: () => { } };
function quietProtobus() {
    (0, protobus_1.setLogger)(silent);
    (0, protobus_1.setLogLevel)(protobus_1.LogLevel.Silent);
}
