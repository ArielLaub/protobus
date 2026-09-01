"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
async function main(context) {
    const audit = new protobus_1.ServiceProxy(context, 'Audit.Service');
    await audit.init();
    // Fire-and-forget: resolves once the broker confirms the publish. The
    // resolved value is {} — there is no reply to decode.
    await audit.record({ event: 'login' }, 'user-123', false);
    // A control message that should overtake a bulk backlog. Only has an
    // effect on a queue the service declared with maxPriority.
    await audit.record({ event: 'shutdown' }, 'ops', true, 5000, { priority: protobus_1.Config.PRIORITY_CONTROL });
}
