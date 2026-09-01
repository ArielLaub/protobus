"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
/** Classify a publish failure into "republish is safe" and "republish may duplicate". */
function isAmbiguous(error) {
    return error instanceof protobus_1.PublishConfirmTimeoutError || error instanceof protobus_1.ChannelClosedError;
}
function isDefiniteFailure(error) {
    return error instanceof protobus_1.PublishNackedError || error instanceof protobus_1.UnroutableError;
}
