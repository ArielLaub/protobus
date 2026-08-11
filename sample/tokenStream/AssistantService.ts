import * as path from 'path';

import MessageService from '../../lib/message_service';
import { IContext } from '../../lib/context';
import { MessageHandlerContext } from '../../lib/connection';

/**
 * A streaming service that emits tokens one at a time, standing in for an LLM.
 *
 * The part worth copying is `context.signal`. Everything else here is
 * scaffolding to make the demo observable.
 */
export class AssistantService extends MessageService {
    public tokensGenerated = 0;
    public stoppedEarly = false;

    public get ServiceName(): string { return 'Chat.Assistant'; }
    public get ProtoFileName(): string { return path.join(__dirname, 'chat.proto'); }

    /**
     * Server-streaming handler. The 4th argument carries the framework's
     * per-message context; `signal` aborts when the caller cancels — because it
     * broke out of its `for await`, passed an AbortSignal that fired, or went
     * away entirely.
     *
     * Checking it is what makes cancellation *save work*. A handler that
     * ignores it keeps running to the end; the framework stops publishing, so
     * the caller is unaffected either way, but the work is still done and, for
     * a real model, still paid for.
     */
    public async *generate(
        request: { prompt: string; token_delay_ms?: number },
        _actor?: string,
        _correlationId?: string,
        context?: MessageHandlerContext,
    ): AsyncIterable<{ index: number; text: string }> {
        const words = fakeCompletion(request.prompt);
        const delay = request.token_delay_ms || 60;

        this.tokensGenerated = 0;
        this.stoppedEarly = false;

        for (let i = 0; i < words.length; i++) {
            if (context?.signal?.aborted) {
                // In a real service this is where you abort the upstream call:
                //   openai.chat.completions.create({ ..., signal: context.signal })
                // and let the SDK tear down the HTTP request.
                this.stoppedEarly = true;
                return;
            }

            this.tokensGenerated = i + 1;
            yield { index: i, text: words[i] };

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    public async stats(): Promise<{ tokens_generated: number; stopped_early: boolean }> {
        return {
            tokens_generated: this.tokensGenerated,
            stopped_early: this.stoppedEarly,
        };
    }
}

/** A long, deterministic "completion" so the demo always has more to say. */
function fakeCompletion(prompt: string): string[] {
    const body = `Answering "${prompt}". ` + (
        'Streaming responses arrive one token at a time, which is what lets a chat ' +
        'interface render text as it is produced rather than waiting for a whole ' +
        'reply. That same property is what makes stopping useful: when the reader ' +
        'has seen enough, there is no reason to keep generating, and every token ' +
        'after that point is wasted work on the server and wasted money at the ' +
        'model. This sentence continues for a while so there is always something ' +
        'left to cancel. '
    ).repeat(3);

    return body.split(/\s+/).filter(Boolean).map((w) => `${w} `);
}
