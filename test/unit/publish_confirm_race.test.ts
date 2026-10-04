import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import MessageDispatcher, { DisconnectedError } from '../../lib/message_dispatcher';
import { RpcTimeoutError } from '../../lib/errors';

/**
 * A connection stub whose publish resolves only when the test says so, which is
 * how a broker confirm behaves under load: the request is on the wire long
 * before the ack comes back.
 */
class SlowConfirmConnection extends EventEmitter {
    public isConnected = true;
    public isReconnecting = false;
    public releaseConfirm!: () => void;
    public failConfirm!: (err: Error) => void;
    public publishCalls = 0;

    private confirmed = new Promise<void>((resolve, reject) => {
        this.releaseConfirm = resolve;
        this.failConfirm = reject;
    });

    async openChannel(): Promise<any> {
        return {
            prefetch: async () => undefined,
            consume: async () => ({ consumerTag: 'tag' }),
            close: async () => undefined,
        };
    }
    async closeChannel() { return undefined; }
    async declareExchange() { return undefined; }
    async declareQueue(_ch: any, name: string) { return name || 'callback.queue'; }
    async bindQueue() { return undefined; }
    async unbindQueue() { return undefined; }
    async deleteQueue() { return undefined; }
    async ack() { return undefined; }
    async reject() { return undefined; }
    async consume() { return { consumerTag: 'tag' }; }
    async cancel() { return undefined; }
    async purgeQueue() { return undefined; }
    async connect() { return {} as any; }
    async disconnect() { return undefined; }

    async publish(): Promise<void> {
        this.publishCalls += 1;
        return this.confirmed;
    }
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The audit's reproduction, run in its own process under
 * `--unhandled-rejections=strict` so an unobserved rejection is a non-zero
 * exit rather than a warning Jest might absorb. Requires `dist/`, as
 * packaging.test.ts does.
 */
const STRICT_CHILD = `
const { EventEmitter } = require('events');
const Dispatcher = require(${JSON.stringify(path.join(REPO_ROOT, 'dist/lib/message_dispatcher'))}).default;

(async () => {
    const c = new EventEmitter();
    Object.assign(c, {
        isConnected: true,
        isReconnecting: false,
        openChannel: async () => ({}),
        declareExchange: async () => {},
        declareQueue: async () => 'cb',
        bindQueue: async () => {},
        consume: async () => {},
        // Confirm arrives well after the 10ms RPC deadline below.
        publish: async () => new Promise(resolve => setTimeout(resolve, 60)),
    });
    const d = new Dispatcher(c);
    await d.init();
    try {
        await d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 10);
        process.exit(2);
    } catch (e) {
        if (e.name !== 'RpcTimeoutError') { process.exit(3); }
    }
    // Outlive the late confirm, so a rejection it strands still lands here.
    await new Promise(resolve => setTimeout(resolve, 120));
})();
`;

describe('a reply deadline that expires while the publish confirm is in flight', () => {
    it('does not strand an unhandled rejection', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-confirm-race-'));
        const script = path.join(dir, 'race.js');
        fs.writeFileSync(script, STRICT_CHILD);
        try {
            execFileSync(process.execPath, ['--unhandled-rejections=strict', script], {
                stdio: ['ignore', 'pipe', 'pipe'],
                encoding: 'utf8',
                timeout: 20000,
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('still rejects the caller with the timeout', async () => {
        const conn = new SlowConfirmConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const call = d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 20);
        // The deadline expires first; the broker confirms afterwards.
        await new Promise(resolve => setTimeout(resolve, 50));
        conn.releaseConfirm();

        await expect(call).rejects.toBeInstanceOf(RpcTimeoutError);
        expect((d as any).callbacks.size).toBe(0);
    });

    it('reports the publish failure, not the deadline, when both happen', async () => {
        const conn = new SlowConfirmConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const call = d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 20);
        // Let the deadline pass, then fail the confirm: the request never
        // reached the broker, which is the more specific cause.
        await new Promise(resolve => setTimeout(resolve, 50));
        conn.failConfirm(new Error('NACK'));

        await expect(call).rejects.toThrow('NACK');
        expect((d as any).callbacks.size).toBe(0);
    });

    it('surfaces a disconnect that lands while the confirm is pending', async () => {
        const conn = new SlowConfirmConnection();
        const d = new MessageDispatcher(conn as any);
        await d.init();

        const call = d.publish(Buffer.from('x'), 'REQUEST.A.B.c', true, 5000);
        await new Promise(resolve => setImmediate(resolve));
        conn.emit('disconnected');
        conn.releaseConfirm();

        await expect(call).rejects.toBeInstanceOf(DisconnectedError);
        expect((d as any).callbacks.size).toBe(0);
    });
});
