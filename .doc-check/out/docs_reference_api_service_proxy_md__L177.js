"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main(context) {
    const assistant = new protobus_1.ServiceProxy(context, 'Chat.Assistant');
    await assistant.init();
    const stop = new AbortController();
    // No await on the call itself; the AsyncIterable is returned synchronously.
    for await (const token of assistant.generate({ prompt: 'hello' }, 'user-123', 30000, { signal: stop.signal })) {
        process.stdout.write(token.text);
    }
}
