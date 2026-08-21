import Context from '../../lib/context';
import MessageService from '../../lib/message_service';
import ServiceProxy from '../../lib/service_proxy';
import { setLevel, LogLevel } from '../../lib/logger';

const PROTO = `
syntax = "proto3";
package Recov;
service Svc { rpc echo(Req) returns (Res); }
message Req { string text = 1; }
message Res { string text = 1; }
`;

class Svc extends MessageService {
    get ServiceName() { return 'Recov.Svc'; }
    get ProtoFileName() { return 'Recov.proto'; }
    get Proto() { return PROTO; }
    async echo(req: any) { return { text: `echo:${req.text}` }; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MGMT = process.env.RABBITMQ_MGMT || 'http://guest:guest@localhost:15672';
const base = new URL(MGMT);
const auth = 'Basic ' + Buffer.from(`${base.username}:${base.password}`).toString('base64');
const origin = `${base.protocol}//${base.host}`;

/**
 * A vhost of this test's own.
 *
 * Integration files run in parallel workers and this test works by closing
 * connections from the broker side, so it needs a way to close only its own.
 * Matching on the client's local port does not survive Docker's NAT, which
 * rewrites the source port; a private vhost is exact and also keeps the queues
 * clear of everything else.
 */
const VHOST = 'protobus-recovery-test';

const api = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { ...init, headers: { Authorization: auth, ...(init.headers || {}) } });

/** True when the management plugin is reachable, which this test needs. */
async function managementAvailable(): Promise<boolean> {
    try {
        return (await api('/api/overview')).ok;
    } catch {
        return false;
    }
}

async function createVhost(): Promise<void> {
    await api(`/api/vhosts/${encodeURIComponent(VHOST)}`, { method: 'PUT' });
    await api(`/api/permissions/${encodeURIComponent(VHOST)}/${encodeURIComponent(base.username)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configure: '.*', write: '.*', read: '.*' }),
    });
}

async function deleteVhost(): Promise<void> {
    await api(`/api/vhosts/${encodeURIComponent(VHOST)}`, { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Close every connection on this test's vhost, which is exactly its own.
 *
 * The listing is polled because the management plugin publishes connections on
 * its statistics interval, so one just opened is not there yet.
 */
async function killOwnConnections(): Promise<number> {
    let mine: any[] = [];
    const deadline = Date.now() + 30000;
    for (;;) {
        const list: any[] = await api('/api/connections').then(r => r.json() as any);
        mine = list.filter((c) => c.vhost === VHOST);
        if (mine.length > 0 || Date.now() > deadline) break;
        await sleep(500);
    }
    for (const conn of mine) {
        await api(`/api/connections/${encodeURIComponent(conn.name)}`, {
            method: 'DELETE',
            headers: { 'X-Reason': 'protobus reconnect recovery test' },
        });
    }
    return mine.length;
}

describe('recovery across a real broker restart', () => {
    jest.setTimeout(180000);

    it('parks work through the outage and serves again afterwards', async () => {
        if (!(await managementAvailable())) {
             
            console.warn(`skipping: RabbitMQ management API not reachable at ${origin}`);
            return;
        }
        setLevel(LogLevel.Error);
        await createVhost();
        const ctx = new Context();
        const url = `amqp://${base.username}:${base.password}@${base.hostname}:5672/${encodeURIComponent(VHOST)}`;
        await ctx.init(url, [], {
            reconnection: { maxRetries: 0, initialDelayMs: 300, maxDelayMs: 2000 },
        });
        const svc = new Svc(ctx);
        await svc.init();
        const proxy: any = new ServiceProxy(ctx, 'Recov.Svc');
        await proxy.init();

        expect((await proxy.echo({ text: 'one' })).text).toBe('echo:one');

        const seen: string[] = [];
        let readyAtAnnounce: boolean | undefined;
        let disconnected!: () => void;
        let reconnected!: () => void;
        const sawDisconnect = new Promise<void>((r) => { disconnected = r; });
        const sawReconnect = new Promise<void>((r) => { reconnected = r; });
        ctx.connection.on('disconnected', () => { seen.push('disconnected'); disconnected(); });
        ctx.connection.on('reconnected', () => {
            seen.push('reconnected');
            // The assertion this whole change exists for: by the time the
            // announcement lands, the topology behind it is already back.
            readyAtAnnounce = (ctx.connection as any).isReady;
            reconnected();
        });

        // Severed from the broker side. Stopping the container is not usable
        // here: Docker Desktop's port forwarder keeps localhost:5672 accepting
        // behind a dead container, so the client socket never breaks and there
        // is no outage to observe.
        expect(await killOwnConnections()).toBe(1);

        // Issued into the gap, before the socket loss has even been noticed.
        const parked = proxy.echo({ text: 'parked' }, undefined, true, 120000)
            .then((r: any) => ({ ok: true, text: r.text }))
            .catch((e: any) => ({ ok: false, text: `${e?.name}: ${e?.message}` }));

        await Promise.race([sawDisconnect, sleep(30000)]);
        expect(seen).toContain('disconnected');

        await Promise.race([sawReconnect, sleep(60000)]);
        expect(seen).toContain('reconnected');
        expect(readyAtAnnounce).toBe(true);
        expect(seen).toEqual(['disconnected', 'reconnected']);

        // A publish issued mid-outage is waited through, not failed.
        expect((await parked).text).toBe('echo:parked');

        // And the restored topology actually serves new work.
        expect((await proxy.echo({ text: 'after' })).text).toBe('echo:after');

        await svc.stopConsuming();
        await ctx.connection.disconnect();
        await deleteVhost();
    });
});
