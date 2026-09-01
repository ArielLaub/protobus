import { bigintToBytes, bytesToBigint } from 'protobus';

const wire = bigintToBytes('0xdeadbeef');       // Uint8Array(32), big-endian
console.log(wire.length);                        // 32
console.log(bytesToBigint(wire));                // 3735928559n
console.log(bytesToBigint(new Uint8Array(0)));   // 0n — empty decodes to zero
