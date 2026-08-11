/**
 * Cross-language integration test: TS client → Python server.
 *
 * This is the pair that matters for the chat performance work — the API
 * (TS) calls into ChatAgent (Python) over ProtoBus. Each per-language
 * integration test already proves the wire protocol within its own
 * runtime; this test proves the wire protocol is *identical* across runtimes.
 *
 * Mechanism:
 *   1. Spawn ../../../protobus-py's CounterService as a Python subprocess
 *      via `python_counter_server.py`. The script signals readiness by
 *      printing "READY\n" on stdout.
 *   2. Stand up a normal TS Context + ServiceProxy against the same broker.
 *   3. Drive the same streaming scenarios that the per-language suites use.
 *
 * Prerequisites:
 *   - Real RabbitMQ at amqp://guest:guest@127.0.0.1:5672/
 *     (docker-compose up -d in protobus-go/ provides this)
 *   - ../../../protobus-py with its venv installed and `protoc` on PATH
 *
 * Run:
 *   npm run test:integration -- cross-language.test.ts
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as protobuf from 'protobufjs';

import ServiceProxy from '../../lib/service_proxy';
import Context from '../../lib/context';

const AMQP_URL = 'amqp://guest:guest@127.0.0.1:5672/';

const CROSS_LANG_DIR = path.resolve(__dirname, 'cross-lang');
const PROTO_DIR = path.join(CROSS_LANG_DIR, 'proto');
const PROTO_FILE = path.join(PROTO_DIR, 'streaming_test.proto');
const SERVER_SCRIPT = path.join(CROSS_LANG_DIR, 'python_counter_server.py');

const PROTOBUS_PY_REPO = path.resolve(__dirname, '../../../protobus-py');
const PY_VENV = path.join(PROTOBUS_PY_REPO, 'venv/bin/python');

describe('Cross-language: TS client → Python server', () => {
    let pythonProc: ChildProcess | null = null;
    let context: Context | null = null;
    let proxy: any;

    /**
     * Spawn the Python server and resolve when it prints READY (or reject on
     * timeout / process exit). Stderr is mirrored to our stderr so test
     * failures aren't opaque.
     */
    function spawnPythonServer(): Promise<ChildProcess> {
        return new Promise((resolve, reject) => {
            const proc = spawn(
                PY_VENV,
                [SERVER_SCRIPT],
                {
                    env: {
                        ...process.env,
                        // protobus-py sits in a sibling repo, not on PYTHONPATH
                        PYTHONPATH: PROTOBUS_PY_REPO,
                        PROTOBUS_TEST_AMQP: AMQP_URL,
                        PROTOBUS_TEST_PROTO_DIR: PROTO_DIR,
                    },
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );

            const timeout = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error('Python server did not signal READY within 30s'));
            }, 30_000);

            proc.stdout?.on('data', (chunk) => {
                const s = chunk.toString();
                if (s.includes('READY')) {
                    clearTimeout(timeout);
                    resolve(proc);
                }
            });

            proc.stderr?.on('data', (chunk) => {
                // Surface Python errors to Jest output without buffering — easier
                // to diagnose than waiting for the timeout.
                process.stderr.write(`[py-server] ${chunk}`);
            });

            proc.on('exit', (code, signal) => {
                clearTimeout(timeout);
                if (code !== 0 && code !== null) {
                    reject(new Error(`Python server exited prematurely (code=${code}, signal=${signal})`));
                }
            });
        });
    }

    beforeAll(async () => {
        // Sanity-check the prereqs upfront so a missing venv fails fast with
        // a clear message rather than a confusing spawn ENOENT.
        if (!fs.existsSync(PY_VENV)) {
            throw new Error(
                `Python venv not found at ${PY_VENV}. ` +
                `Cross-language test requires protobus-py installed with venv. ` +
                `cd ${PROTOBUS_PY_REPO} && python3 -m venv venv && ./venv/bin/pip install -e .`
            );
        }
        if (!fs.existsSync(PROTO_FILE)) {
            throw new Error(`Proto file missing: ${PROTO_FILE}`);
        }

        pythonProc = await spawnPythonServer();

        // TS client side. Load the same proto file so the responseStream flag
        // resolves the same way it does on the Python side.
        context = new Context();
        await context.init(AMQP_URL, []);
        const root = new protobuf.Root();
        root.loadSync(PROTO_FILE, { keepCase: true });
        (context.factory as any).root = root;

        proxy = new ServiceProxy(context, 'streaming_test.Counter');
        await proxy.init();
    }, 60_000);

    afterAll(async () => {
        if (context && context.isConnected) {
            await context.connection.disconnect();
        }
        if (pythonProc && pythonProc.exitCode === null) {
            pythonProc.kill('SIGTERM');
            // Give it 2s to shutdown cleanly, then SIGKILL.
            await new Promise(r => setTimeout(r, 2000));
            if (pythonProc.exitCode === null) {
                pythonProc.kill('SIGKILL');
            }
        }
    });

    it('TS unary call → Python handler returns the result', async () => {
        const res = await proxy.add({ a: 5, b: 7 });
        expect(res).toHaveProperty('sum', 12);
    });

    it('TS streaming call → Python handler streams 5 chunks in order', async () => {
        const chunks: any[] = [];
        for await (const chunk of proxy.tick({ count: 5 })) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(5);
        // payload (string, non-default) is the reliable ordering signal —
        // proto3 strips scalar defaults so seq=0 would be absent on chunk 0.
        chunks.forEach((c, i) => {
            expect(c.payload).toBe(`chunk-${i}`);
        });
    });

    it('TS streaming call → Python empty stream ends cleanly', async () => {
        const chunks: any[] = [];
        for await (const chunk of proxy.tick({ emit_nothing: true })) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(0);
    });

    it('Mid-stream Python HandledError propagates to TS as a thrown error', async () => {
        const chunks: any[] = [];
        let caught: any = null;
        try {
            for await (const chunk of proxy.tick({ count: 10, fail_at: 2 })) {
                chunks.push(chunk);
            }
        } catch (e) {
            caught = e;
        }
        expect(chunks).toHaveLength(2);
        expect(caught).not.toBeNull();
        // HandledError(code='TEST_FAIL') survives the cross-language round-trip.
        expect((caught as any).code).toBe('TEST_FAIL');
        expect(String(caught.message)).toContain('deliberate failure');
    });
});
