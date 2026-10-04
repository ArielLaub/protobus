import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateService } from '../../lib/cli/generate-service';
import { generateTypes } from '../../lib/cli/generate-types';

/**
 * `generate:service` read schemas with regular expressions (#27): a nested
 * block, such as an rpc's empty `{}` body, truncated the service and dropped
 * the methods after it; qualified and dotted names were missed; and the
 * service's own name was discarded for `<package>.Service`. The type
 * generator shared that assumption, renaming every service to `Service` and
 * stamping `ServiceName = '<package>.Service'`, a name the bus does not use
 * for `service Math`.
 *
 * The skeleton never compiled under `strict` for any schema: it declared
 * `implements <package>.Service`, but that interface is the CALLER's proxy
 * shape (each method also carries path and stream metadata), which no server
 * class can satisfy. It now follows the documented pattern, a ServiceName
 * getter, and gets its safety from the typed method signatures.
 *
 * Each case generates types and a service into a scratch project and then
 * compiles the service against them, which is the only proof that the two
 * agree.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function project(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-gensvc-'));
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(dir, 'proto', name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return dir;
}

async function generate(dir: string, name: string): Promise<{ types: string; service: string }> {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
        await generateTypes(dir);
        await generateService(name, dir);
    } finally {
        log.mockRestore();
    }
    return {
        types: fs.readFileSync(path.join(dir, 'common/types/proto.ts'), 'utf-8'),
        service: fs.readFileSync(path.join(dir, 'services', name.toLowerCase(), `${name}Service.ts`), 'utf-8'),
    };
}

function typecheck(dir: string, name: string): void {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            strict: true, noEmit: true, target: 'ES2020', module: 'commonjs', moduleResolution: 'node',
            lib: ['ES2020', 'ESNext.AsyncIterable'], skipLibCheck: true, types: ['node'],
            typeRoots: [path.join(REPO_ROOT, 'node_modules/@types')],
            baseUrl: '.', paths: { protobus: [path.join(REPO_ROOT, 'dist/index')] },
        },
        files: [`services/${name.toLowerCase()}/${name}Service.ts`],
    }));
    try {
        execFileSync(path.join(REPO_ROOT, 'node_modules/.bin/tsc'), ['-p', path.join(dir, 'tsconfig.json')],
            { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 });
    } catch (err: any) {
        throw new Error(`generated service does not compile:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    }
}

describe('generate:service on ordinary protobuf schemas', () => {
    jest.setTimeout(180000);

    it('keeps every method of a service with empty rpc bodies, and its real name', async () => {
        const dir = project({
            'Calculator.proto': `syntax = "proto3";
package Calculator;
service Math {
  option deprecated = false;
  rpc add (AddRequest) returns (AddResponse) {}
  rpc sub (SubRequest) returns (SubResponse) {}
  rpc ticks (AddRequest) returns (stream AddResponse) {}
}
message AddRequest { int32 a = 1; int32 b = 2; }
message AddResponse { int32 result = 1; }
message SubRequest { int32 a = 1; int32 b = 2; }
message SubResponse { int32 result = 1; }
`,
        });
        const { types, service } = await generate(dir, 'Calculator');

        expect(types).toContain("MathServiceName = 'Calculator.Math'");
        // A package with one service keeps the short names, now correct.
        expect(types).toContain("ServiceName = 'Calculator.Math'");
        expect(types).not.toContain("'Calculator.Service'");

        expect(service).toMatch(/class MathService extends RunnableService \{/);
        expect(service).toContain('return Calculator.MathServiceName;');
        expect(service).toMatch(/async add\(request: Calculator\.IAddRequest\): Promise<Calculator\.IAddResponse>/);
        expect(service).toMatch(/async sub\(request: Calculator\.ISubRequest\): Promise<Calculator\.ISubResponse>/);
        expect(service).toMatch(/async \*ticks\(request: Calculator\.IAddRequest\): AsyncIterable<Calculator\.IAddResponse>/);
        typecheck(dir, 'Calculator');
    });

    it('handles a dotted package, several services, and types from other packages', async () => {
        const dir = project({
            'common/money.proto': `syntax = "proto3";
package com.example.common;
message Money { int64 cents = 1; string currency = 2; }
`,
            'Billing.proto': `syntax = "proto3";
package com.example.billing;
import "common/money.proto";
message Invoice {
  string id = 1;
  message Line { string sku = 1; }
  repeated Line lines = 2;
}
service Invoices { rpc total (Invoice) returns (com.example.common.Money); }
service Payments { rpc pay (com.example.common.Money) returns (Invoice.Line); }
`,
        });
        const { types, service } = await generate(dir, 'Billing');

        expect(types).toContain("InvoicesServiceName = 'com.example.billing.Invoices'");
        expect(types).toContain("PaymentsServiceName = 'com.example.billing.Payments'");

        expect(service).toMatch(/class InvoicesService extends RunnableService \{/);
        expect(service).toMatch(/class PaymentsService extends RunnableService \{/);
        expect(service).toContain('return com.example.billing.InvoicesServiceName;');
        expect(service).toMatch(/total\(request: com\.example\.billing\.IInvoice\): Promise<com\.example\.common\.IMoney>/);
        expect(service).toMatch(/pay\(request: com\.example\.common\.IMoney\): Promise<com\.example\.billing\.Invoice\.ILine>/);
        typecheck(dir, 'Billing');
    });

    it('still emits the established names for a service called Service', async () => {
        const dir = project({
            'Shop.proto': `syntax = "proto3";
package Shop;
service Service { rpc buy (Req) returns (Res); }
message Req { string sku = 1; }
message Res { bool ok = 1; }
`,
        });
        const { types, service } = await generate(dir, 'Shop');
        expect(types).toContain("ServiceName = 'Shop.Service'");
        expect(types).not.toContain('ServiceServiceName');
        expect(service).toMatch(/class ShopService extends RunnableService \{/);
        expect(service).toContain('return Shop.ServiceName;');
        typecheck(dir, 'Shop');
    });

    it('fails loudly on a file that declares no service', async () => {
        const dir = project({ 'Empty.proto': 'syntax = "proto3";\npackage Empty;\nmessage M { string a = 1; }\n' });
        await expect(generateService('Empty', dir)).rejects.toThrow(/no service/i);
    });
});
