"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
function describe(error) {
    if (error instanceof protobus_1.PublishNackedError)
        return 'definite: broker refused it, republish is safe';
    if (error instanceof protobus_1.UnroutableError)
        return 'definite: matched no queue, republish is safe';
    if (error instanceof protobus_1.PublishConfirmTimeoutError)
        return 'AMBIGUOUS: no confirm arrived';
    if (error instanceof protobus_1.ChannelClosedError)
        return 'AMBIGUOUS: channel closed unconfirmed';
    if (error instanceof protobus_1.PublishError)
        return 'publish failed';
    return 'not a publish failure';
}
