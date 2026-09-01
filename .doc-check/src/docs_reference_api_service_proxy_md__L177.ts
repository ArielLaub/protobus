import { IContext, ServiceProxy, StreamOptions } from 'protobus';

interface ChatAssistant {
    generate(
        request: { prompt: string },
        actor?: string,
        idleTimeoutMs?: number,
        options?: StreamOptions,
    ): AsyncIterable<{ index: number; text: string }>;
}

async function main(context: IContext) {
    const assistant = new ServiceProxy(context, 'Chat.Assistant') as ServiceProxy & ChatAssistant;
    await assistant.init();

    const stop = new AbortController();

    // No await on the call itself; the AsyncIterable is returned synchronously.
    for await (const token of assistant.generate(
        { prompt: 'hello' }, 'user-123', 30000, { signal: stop.signal },
    )) {
        process.stdout.write(token.text);
    }
}
