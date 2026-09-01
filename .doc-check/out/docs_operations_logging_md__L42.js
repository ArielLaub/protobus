"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
(0, protobus_1.setLogLevel)(protobus_1.LogLevel.Debug);
console.log((0, protobus_1.getLogLevel)() === protobus_1.LogLevel.Debug);
