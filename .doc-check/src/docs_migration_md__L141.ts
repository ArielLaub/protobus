import { PublishError, PublishNackedError, UnroutableError, PublishConfirmTimeoutError, ChannelClosedError } from 'protobus';

function describe(error: unknown): string {
    if (error instanceof PublishNackedError) return 'definite: broker refused it, republish is safe';
    if (error instanceof UnroutableError) return 'definite: matched no queue, republish is safe';
    if (error instanceof PublishConfirmTimeoutError) return 'AMBIGUOUS: no confirm arrived';
    if (error instanceof ChannelClosedError) return 'AMBIGUOUS: channel closed unconfirmed';
    if (error instanceof PublishError) return 'publish failed';
    return 'not a publish failure';
}
