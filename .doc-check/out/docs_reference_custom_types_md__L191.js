"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
const wire = (0, protobus_1.bigintToBytes)('0xdeadbeef'); // Uint8Array(32), big-endian
console.log(wire.length); // 32
console.log((0, protobus_1.bytesToBigint)(wire)); // 3735928559n
console.log((0, protobus_1.bytesToBigint)(new Uint8Array(0))); // 0n — empty decodes to zero
