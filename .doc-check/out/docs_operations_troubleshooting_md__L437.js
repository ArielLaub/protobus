"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleEvent = handleEvent;
const processed = new Set();
async function handleEvent(event) {
    if (processed.has(event.id)) {
        return;
    }
    processed.add(event.id);
    // ... do the work
}
