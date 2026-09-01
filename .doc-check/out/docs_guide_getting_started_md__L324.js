"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContext = createContext;
const protobus_1 = require("protobus");
// ---- from docs/guide/getting-started.md:152 (needs=gs-context) ----
// src/context.ts
async function createContext() {
    const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
    const PROTO_PATHS = [__dirname + '/proto/'];
    const context = new protobus_1.Context();
    await context.init(AMQP_URL, PROTO_PATHS);
    return context;
}
// src/event-subscriber.ts
class EventSubscriber extends protobus_1.RunnableService {
    get ServiceName() { return 'Calculator.Subscriber'; }
    constructor(context) {
        super(context);
    }
}
async function main() {
    const context = await createContext();
    const subscriber = new EventSubscriber(context);
    await subscriber.init();
    await subscriber.subscribeEvent('Calculator.CalculationEvent', async (event) => {
        console.log(`Received event: ${event.operation} = ${event.result}`);
    });
    console.log('Listening for events...');
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
