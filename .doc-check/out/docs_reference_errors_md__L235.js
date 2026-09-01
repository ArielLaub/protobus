"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function drain(chunks) {
    let out = '';
    try {
        for await (const chunk of chunks)
            out += chunk.text;
    }
    catch (error) {
        if (error instanceof protobus_1.StreamSequenceError)
            throw error; // data is incomplete; do not use `out`
        if (error instanceof protobus_1.StreamTimeoutError)
            return out; // producer stalled; partial is acceptable here
        if (error instanceof protobus_1.StreamBackpressureError)
            throw error; // we are too slow; fix the consumer
        if (error instanceof protobus_1.DisconnectedError)
            throw error; // the socket went, not the stream
        if (error instanceof protobus_1.StreamingError)
            throw error;
        throw error;
    }
    return out;
}
