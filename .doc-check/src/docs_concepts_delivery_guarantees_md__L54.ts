import { PublishNackedError, UnroutableError, PublishConfirmTimeoutError, ChannelClosedError } from 'protobus';

/** Classify a publish failure into "republish is safe" and "republish may duplicate". */
function isAmbiguous(error: unknown): boolean {
    return error instanceof PublishConfirmTimeoutError || error instanceof ChannelClosedError;
}

function isDefiniteFailure(error: unknown): boolean {
    return error instanceof PublishNackedError || error instanceof UnroutableError;
}
