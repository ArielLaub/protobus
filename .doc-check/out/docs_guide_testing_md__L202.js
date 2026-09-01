"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupQueues = cleanupQueues;
const amqplib = __importStar(require("amqplib"));
const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
/** Delete a service's queues so a re-run is not blocked by stale arguments. */
async function cleanupQueues(names) {
    const conn = await amqplib.connect(AMQP_URL);
    for (const name of names) {
        // A failed delete kills the channel, so use one channel per queue.
        const ch = await conn.createChannel();
        ch.on('error', () => undefined);
        try {
            await ch.deleteQueue(name);
        }
        catch { /* already gone */ }
        try {
            await ch.close();
        }
        catch { /* channel died on the delete */ }
    }
    await conn.close();
}
