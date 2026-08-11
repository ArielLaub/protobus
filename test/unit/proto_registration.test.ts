import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import MessageFactory from '../../lib/message_factory';
import MessageService from '../../lib/message_service';

/**
 * Two ordering defects around proto/custom-type registration:
 *
 *  1. init() called protoBuf.loadSync(), which resolves eagerly, *before*
 *     adding the built-in custom types to the root. So a .proto on disk using
 *     `bigint` blew up at startup with "no such type: 'bigint'" — the library's
 *     headline feature was unusable through its own documented entry point.
 *
 *  2. A service has to be able to register its own schema, and doing so twice
 *     must not throw.
 */
describe('custom types in on-disk protos', () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-protos-'));
        fs.writeFileSync(path.join(dir, 'Wallet.proto'), `
            syntax = "proto3";
            package Wallet;
            message Balance { bigint amount = 1; timestamp as_of = 2; }
            message Query   { string account = 1; }
            service Api { rpc balance (Query) returns (Balance); }
        `);
        // Must be ignored by discovery: only *.proto should be loaded.
        fs.writeFileSync(path.join(dir, 'notes.protocol.txt'), 'not a proto file');
        fs.writeFileSync(path.join(dir, 'Wallet.proto.bak'), 'syntax = "proto3"; @@@ invalid @@@');
    });

    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('loads a proto that uses bigint and timestamp without throwing', () => {
        const f = new MessageFactory();
        expect(() => f.init([dir])).not.toThrow();
    });

    it('round-trips a bigint declared in an on-disk proto', () => {
        const f = new MessageFactory();
        f.init([dir]);
        const buf = f.buildResponse('Wallet.Api.balance', { amount: 10n ** 30n });
        const res = f.decodeResponse(buf);
        expect(res.result!.data.amount).toBe(10n ** 30n);
    });

    it('ignores files that merely contain ".proto" in the name', () => {
        const f = new MessageFactory();
        expect(() => f.init([dir])).not.toThrow();
        // Wallet.proto.bak is invalid; if discovery had picked it up, loadSync
        // above would have failed.
        expect(f.root.lookupService('Wallet.Api')).toBeTruthy();
    });
});

describe('registering a service schema more than once', () => {
    const PROTO = `
        syntax = "proto3";
        package Dup;
        message A { string x = 1; }
        service Svc { rpc go (A) returns (A); }
    `;

    it('is idempotent', () => {
        const f = new MessageFactory();
        f.init([]);
        f.parse(PROTO, 'Dup.Svc');
        expect(() => f.parse(PROTO, 'Dup.Svc')).not.toThrow();
        expect(f.root.lookupService('Dup.Svc')).toBeTruthy();
    });

    it('reports whether a service is already registered', () => {
        const f = new MessageFactory();
        f.init([]);
        expect(f.hasService('Dup.Svc')).toBe(false);
        f.parse(PROTO, 'Dup.Svc');
        expect(f.hasService('Dup.Svc')).toBe(true);
    });
});

/**
 * MessageService.init() registers its own schema so a service works standalone —
 * which is how it has always actually been deployed.
 */
describe('MessageService registers its own schema', () => {
    let dir: string;
    let protoPath: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-svc-'));
        protoPath = path.join(dir, 'Standalone.proto');
        fs.writeFileSync(protoPath, `
            syntax = "proto3";
            package Standalone;
            message Req { string x = 1; }
            message Res { string y = 1; }
            service Api { rpc go (Req) returns (Res); }
        `);
    });

    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function build(factory: MessageFactory) {
        const listeners: string[] = [];
        const conn: any = new EventEmitter();
        conn.isConnected = true;
        conn.openChannel = async () => ({
            prefetch: async () => undefined,
            consume: async () => ({ consumerTag: 't' }),
            close: async () => undefined,
        });
        conn.declareExchange = async () => undefined;
        conn.declareQueue = async (_c: any, n: string) => n || 'anon';
        conn.bindQueue = async () => { listeners.push('bind'); };
        conn.consume = async () => ({ consumerTag: 't' });
        conn.cancel = async () => undefined;
        conn.closeChannel = async () => undefined;

        const ctx: any = { factory, connection: conn, publishEvent: async () => undefined };

        class Standalone extends MessageService {
            get ServiceName() { return 'Standalone.Api'; }
            get ProtoFileName() { return protoPath; }
            async go() { return { y: 'ok' }; }
        }
        return new Standalone(ctx);
    }

    it('registers its schema during init when nothing else has', async () => {
        const f = new MessageFactory();
        f.init([]);                       // no proto directories at all
        expect(f.hasService('Standalone.Api')).toBe(false);

        await build(f).init();
        expect(f.hasService('Standalone.Api')).toBe(true);
    });

    it('does not fail when the schema was already loaded from a directory', async () => {
        const f = new MessageFactory();
        f.init([dir]);                    // already loaded from disk
        expect(f.hasService('Standalone.Api')).toBe(true);
        await expect(build(f).init()).resolves.toBeUndefined();
    });

    it('can be initialised twice without a duplicate-name error', async () => {
        const f = new MessageFactory();
        f.init([]);
        await build(f).init();
        await expect(build(f).init()).resolves.toBeUndefined();
    });
});
