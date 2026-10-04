import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import MessageFactory from '../../lib/message_factory';

/**
 * exportTS split a service's full name at its FIRST dot, so a service in a
 * multi-segment package came out as `namespace com { interface example }`,
 * losing both the package and the service (#26). Every name has to be
 * resolved where protobuf puts it: the package is everything above the
 * service, and a referenced type lives in its own package's namespace.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const COMMON = `syntax = "proto3";
package com.example.common;
message Money { int64 cents = 1; string currency = 2; }
`;

const SHARED = `syntax = "proto3";
package Shared;
message Tag { string name = 1; }
`;

const BILLING = `syntax = "proto3";
package com.example.billing;
enum Status { DRAFT = 0; PAID = 1; }
message Req {
    string id = 1;
    com.example.common.Money amount = 2;
    Shared.Tag tag = 3;
    message Line { string sku = 1; }
    repeated Line lines = 4;
    Status status = 5;
}
message Res { string id = 1; Status status = 2; }
service Invoice {
    rpc get(Req) returns (Res);
    rpc watch(Req) returns (stream Res);
}
`;

function exported(): string {
    const f = new MessageFactory();
    f.init([]);
    f.parse(COMMON, 'com.example.common');
    f.parse(SHARED, 'Shared');
    f.parse(BILLING, 'com.example.billing.Invoice');
    return f.exportTS('com.example.billing.Invoice');
}

describe('exportTS for a service in a dotted package', () => {
    it('keeps the whole package as the namespace and the service as the interface', () => {
        const ts = exported();
        expect(ts).toContain('export namespace com.example.billing {');
        expect(ts).toMatch(/export interface Invoice \{/);
        expect(ts).not.toMatch(/interface example\b/);
    });

    it('declares unary and streaming methods with the right shapes', () => {
        const ts = exported();
        expect(ts).toMatch(/get\(request: IReq\): Promise<IRes>;/);
        expect(ts).toMatch(/watch\(request: IReq\): AsyncIterable<IRes>;/);
    });

    it('declares a referenced type in its own package and qualifies the reference', () => {
        const ts = exported();
        expect(ts).toContain('export namespace com.example.common {');
        expect(ts).toMatch(/amount\?: \(com\.example\.common\.IMoney \| null\);/);
        expect(ts).toMatch(/tag\?: \(Shared\.ITag \| null\);/);
    });

    it('is TypeScript that type-checks against a consumer', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-exportts-'));
        try {
            const consumer = `
const req: com.example.billing.IReq = {
    id: 'inv-1',
    amount: { cents: '1250', currency: 'EUR' },
    tag: { name: 'vip' },
    lines: [{ sku: 'a' }],
    status: 'PAID',
};
declare const invoice: com.example.billing.Invoice;
export async function use(): Promise<string> {
    const res: com.example.billing.IRes = await invoice.get(req);
    for await (const update of invoice.watch(req)) {
        if (update.status === 'PAID') return update.id ?? '';
    }
    return res.id ?? '';
}
`;
            fs.writeFileSync(path.join(dir, 'out.ts'), exported() + consumer);
            execFileSync(path.join(REPO_ROOT, 'node_modules/.bin/tsc'), [
                '--noEmit', '--strict', '--target', 'ES2020', '--lib', 'ES2020,ESNext.AsyncIterable',
                '--skipLibCheck', path.join(dir, 'out.ts'),
            ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 });
        } catch (err: any) {
            throw new Error(`generated declarations do not type-check:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120000);
});
