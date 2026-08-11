import * as path from 'path';

import Context from '../../lib/context';
import ServiceProxy from '../../lib/service_proxy';
import { set as setLogger } from '../../lib/logger';
import { AssistantService } from './AssistantService';

/**
 * Streaming with cancellation, in the shape a chat UI needs.
 *
 * Run it with a broker up:
 *
 *   docker compose up -d
 *   npx tsc sample/tokenStream/StreamingDemo.ts --outDir /tmp/demo \
 *     --module commonjs --target es2020 --esModuleInterop --skipLibCheck \
 *     --moduleResolution node --experimentalDecorators
 *   cp sample/tokenStream/chat.proto /tmp/demo/sample/tokenStream/
 *   ln -s "$PWD/node_modules" /tmp/demo/node_modules
 *   node /tmp/demo/sample/tokenStream/StreamingDemo.js
 */

const AMQP_CONNECTION_STRING = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';

setLogger({
    debug: () => {},
    info: () => {},
    warn: (msg: string) => console.log(`[WARN] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
});

async function main() {
    const context = new Context();
    await context.init(AMQP_CONNECTION_STRING, [__dirname]);

    const service = new AssistantService(context);
    await service.init();

    const assistant: any = new ServiceProxy(context, service.ServiceName);
    await assistant.init();

    await demoStopButton(assistant, service);
    await demoBreak(assistant, service);
    await demoRunToCompletion(assistant, service);

    await context.connection.disconnect();
}

/**
 * The chat-window case: Stop lives outside the loop, in another request
 * handler, and must take effect immediately rather than at the next token.
 */
async function demoStopButton(assistant: any, service: AssistantService) {
    header('1. Stop button (AbortSignal)');

    const stop = new AbortController();

    // Whatever your Stop endpoint is, this is all it does. In an HTTP server
    // you would keep the controller keyed by conversation id — and passing
    // `req.signal` instead would stop the stream when the user closes the tab.
    setTimeout(() => {
        process.stdout.write('\n  [user pressed Stop]\n');
        stop.abort();
    }, 900);

    process.stdout.write('  ');
    try {
        for await (const token of assistant.generate(
            { prompt: 'why does streaming matter?', token_delay_ms: 60 },
            undefined,          // actor
            undefined,          // idle timeout
            { signal: stop.signal },
        )) {
            process.stdout.write(token.text);
        }
    } catch (err: any) {
        // A stream abandoned mid-flight may surface as a throw; the loop is
        // over either way, which is what the UI cares about.
        if (!stop.signal.aborted) throw err;
    }

    await reportServerSide(assistant, service);
}

/** The simple case: the decision is made inside the loop. */
async function demoBreak(assistant: any, service: AssistantService) {
    header('2. break out of the loop');

    let printed = 0;
    process.stdout.write('  ');
    for await (const token of assistant.generate(
        { prompt: 'what if I only want the first few words?', token_delay_ms: 60 },
    )) {
        process.stdout.write(token.text);
        if (++printed === 8) break;
    }
    process.stdout.write('\n  [consumer stopped reading]\n');

    await reportServerSide(assistant, service);
}

/** The control: nothing cancels, so the server produces everything. */
async function demoRunToCompletion(assistant: any, service: AssistantService) {
    header('3. no cancellation');

    let received = 0;
    for await (const _token of assistant.generate(
        { prompt: 'short answer', token_delay_ms: 1 },
    )) {
        received++;
    }
    console.log(`  received ${received} tokens`);

    await reportServerSide(assistant, service);
}

/**
 * The whole point: ask the server what it actually did. Cancellation that only
 * stops the *reader* would show the full token count here.
 */
async function reportServerSide(assistant: any, service: AssistantService) {
    // Give the cancellation a moment to travel and take effect.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const stats = await assistant.stats({});
    console.log(`  server generated ${stats.tokens_generated} tokens; stopped early: ${stats.stopped_early}`);
    console.log(`  (in-process check: ${service.tokensGenerated} generated, stoppedEarly=${service.stoppedEarly})`);
}

function header(title: string) {
    console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
}

main().catch((err) => {
    console.error('demo failed:', err);
    process.exitCode = 1;
});
