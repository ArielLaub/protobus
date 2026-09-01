"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
function classify(error) {
    if (error instanceof protobus_1.PublishConfirmTimeoutError)
        return 'may-duplicate';
    if (error instanceof protobus_1.ChannelClosedError)
        return 'may-duplicate';
    if (error instanceof protobus_1.PublishNackedError)
        return 'safe-to-retry';
    if (error instanceof protobus_1.UnroutableError)
        return 'safe-to-retry';
    if (error instanceof protobus_1.PublishError)
        return 'may-duplicate'; // future subclasses: assume the worse
    return 'not-a-publish-error';
}
function idOf(error) {
    return error instanceof protobus_1.PublishError ? error.messageId : undefined;
}
