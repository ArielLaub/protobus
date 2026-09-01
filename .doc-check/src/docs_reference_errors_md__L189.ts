import { PublishError, PublishNackedError, UnroutableError, PublishConfirmTimeoutError, ChannelClosedError } from 'protobus';

function classify(error: unknown): 'safe-to-retry' | 'may-duplicate' | 'not-a-publish-error' {
    if (error instanceof PublishConfirmTimeoutError) return 'may-duplicate';
    if (error instanceof ChannelClosedError) return 'may-duplicate';
    if (error instanceof PublishNackedError) return 'safe-to-retry';
    if (error instanceof UnroutableError) return 'safe-to-retry';
    if (error instanceof PublishError) return 'may-duplicate';   // future subclasses: assume the worse
    return 'not-a-publish-error';
}

function idOf(error: unknown): string | undefined {
    return error instanceof PublishError ? error.messageId : undefined;
}
