import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateTypes } from '../../lib/cli/generate-types';
import MessageFactory from '../../lib/message_factory';

/**
 * The generator's output is a promise to the compiler about what the runtime
 * returns. These tests hold the two sides together: what `generateTypes`
 * writes, and what MessageFactory and ServiceProxy actually produce.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PROTO = `
syntax = "proto3";
package Demo;

message M {
    int64   n    = 1;
    uint64  u    = 2;
    fixed64 fx   = 3;
    sfixed64 sfx = 4;
    sint64  sn   = 5;
    string  name = 6;
}

service Calc {
    rpc x(M) returns(M);
    rpc watch(M) returns(stream M);
}
`;

/** Runs the CLI generator over PROTO and returns the emitted TypeScript. */
function generate(): { dir: string; source: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-typegen-'));
    fs.mkdirSync(path.join(dir, 'proto'));
    fs.writeFileSync(path.join(dir, 'proto', 'demo.proto'), PROTO);
    return { dir, source: '', file: path.join(dir, 'common/types/proto.ts') };
}

describe('generated types match the runtime contract', () => {
    let dir: string;
    let file: string;
    let source: string;
    let log: jest.SpyInstance;

    beforeAll(async () => {
        const g = generate();
        dir = g.dir;
        file = g.file;
        // The CLI narrates to stdout, pbjs included, and some of that lands
        // after the promise settles. Nothing here asserts on it.
        log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        await generateTypes(dir);
        source = fs.readFileSync(file, 'utf-8');
    }, 120000);

    afterAll(() => {
        if (log) { log.mockRestore(); }
        if (dir) { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('declares a server-streaming method as an async iterable', () => {
        const watch = source.slice(source.indexOf('type watch = {'));
        expect(watch).toMatch(/AsyncIterable<Demo\.IM>/);
        expect(watch.slice(0, watch.indexOf('};'))).not.toMatch(/Promise</);
    });

    it('leaves a unary method returning a promise', () => {
        const unary = source.slice(source.indexOf('type x = {'), source.indexOf('type watchCallback'));
        expect(unary).toMatch(/Promise<Demo\.IM>/);
        expect(unary).not.toMatch(/AsyncIterable</);
    });

    it('declares the optional call arguments the proxy accepts', () => {
        const unary = source.slice(source.indexOf('type x = {'), source.indexOf('type watchCallback'));
        expect(unary).toMatch(/actor\?: string/);
        expect(unary).toMatch(/timeoutMs\?: number/);
        expect(unary).toMatch(/options\?: CallOptions/);

        const watch = source.slice(source.indexOf('type watch = {'));
        expect(watch).toMatch(/idleTimeoutMs\?: number/);
        expect(watch).toMatch(/options\?: StreamOptions/);
    });

    it('does not declare 64-bit integers as number', () => {
        // `type Long = number` is the claim that breaks: every 64-bit scalar
        // decodes to something that is not a number.
        expect(source).not.toMatch(/^type Long = number;$/m);
    });

    /** Type-checks one consumer file against the generated declarations. */
    function typecheck(source: string): { ok: boolean; output: string } {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'protobus-consumer-'));
        try {
            fs.writeFileSync(path.join(project, 'consumer.ts'), source);
            fs.writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ES2020',
                    lib: ['ES2020', 'ESNext.AsyncIterable'],
                    module: 'commonjs',
                    moduleResolution: 'node',
                    baseUrl: '.',
                    paths: {
                        // The generated file imports protobus for the call
                        // option types. Resolve it the way a consumer does,
                        // through the published declarations in dist/.
                        protobus: [path.join(REPO_ROOT, 'dist/index')],
                        'generated/proto': [file.replace(/\.ts$/, '')],
                    },
                    types: [],
                    skipLibCheck: true,
                },
                include: ['consumer.ts'],
            }));
            try {
                execFileSync(
                    path.join(REPO_ROOT, 'node_modules/.bin/tsc'),
                    ['-p', path.join(project, 'tsconfig.json')],
                    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 },
                );
                return { ok: true, output: '' };
            } catch (err: any) {
                return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
            }
        } finally {
            fs.rmSync(project, { recursive: true, force: true });
        }
    }

    it('compiles a consumer that uses both call shapes', () => {
        const result = typecheck(`
import { Demo } from 'generated/proto';

declare const calc: Demo.Service;

export async function unary(): Promise<bigint> {
    const res = await calc.x({ n: 1 }, 'actor', true, 5000);
    // A 64-bit field decodes to a decimal string, exactly.
    return BigInt(res.n!);
}

export async function streamed(): Promise<string[]> {
    const seen: string[] = [];
    for await (const chunk of calc.watch({ n: 1 }, 'actor', 30000)) {
        seen.push(chunk.name ?? '');
    }
    return seen;
}
`);
        expect(result.output).toBe('');
        expect(result.ok).toBe(true);
    }, 180000);

    it('rejects a consumer that treats a 64-bit field as a number', () => {
        // The defect this guards: the field was declared `number`, so this
        // compiled and then met a runtime value that was not one.
        const result = typecheck(`
import { Demo } from 'generated/proto';

declare const calc: Demo.Service;

export async function bad(): Promise<number> {
    const res = await calc.x({ n: 1 });
    const n: number = res.n!;
    return n + 1;
}
`);
        expect(result.ok).toBe(false);
        expect(result.output).toMatch(/consumer\.ts.*error TS/);
        expect(result.output).toMatch(/not assignable to type 'number'/);
    }, 180000);

    it('rejects awaiting a server-streaming call as a promise', () => {
        const result = typecheck(`
import { Demo } from 'generated/proto';

declare const calc: Demo.Service;

export async function bad(): Promise<string> {
    const res = await calc.watch({ n: 1 });
    return res.name!;
}
`);
        expect(result.ok).toBe(false);
        expect(result.output).toMatch(/consumer\.ts.*error TS/);
        expect(result.output).toMatch(/AsyncIterable/);
    }, 180000);
});

describe('64-bit scalars decode to a precision-preserving representation', () => {
    const factory = new MessageFactory();

    beforeAll(() => {
        factory.init([]);
        factory.parse(`syntax="proto3"; package D;
            message M {
                int64 n = 1; uint64 u = 2; fixed64 fx = 3;
                sfixed64 sfx = 4; sint64 sn = 5;
            }
            service S { rpc x(D.M) returns(D.M); }`);
    });

    const roundTrip = (obj: any) =>
        factory.decodeRequest(factory.buildRequest('D.S.x', obj, 'test')).data as any;

    it.each(['n', 'u', 'fx', 'sfx', 'sn'])('decodes %s as a string', (field) => {
        const out = roundTrip({ [field]: 7 });
        expect(typeof out[field]).toBe('string');
        expect(out[field]).toBe('7');
    });

    it('preserves a value beyond Number.MAX_SAFE_INTEGER', () => {
        expect(roundTrip({ n: '9007199254740993' }).n).toBe('9007199254740993');
        expect(roundTrip({ u: '18446744073709551615' }).u).toBe('18446744073709551615');
    });

    it('preserves the signed boundaries', () => {
        expect(roundTrip({ n: '-9223372036854775808' }).n).toBe('-9223372036854775808');
        expect(roundTrip({ n: '9223372036854775807' }).n).toBe('9223372036854775807');
        expect(roundTrip({ sn: '-9223372036854775808' }).sn).toBe('-9223372036854775808');
    });

    it('keeps the proto3 default readable', () => {
        expect(roundTrip({}).n).toBe('0');
        expect(roundTrip({}).u).toBe('0');
    });

    it('accepts a number, a string or a Long on the way in', () => {
        expect(roundTrip({ n: 42 }).n).toBe('42');
        expect(roundTrip({ n: '42' }).n).toBe('42');
    });
});

describe('exportTS describes the same runtime as the CLI generator', () => {
    const factory = new MessageFactory();

    beforeAll(() => {
        factory.init([]);
        factory.parse(`syntax="proto3"; package E;
            enum Color { RED = 0; BLUE = 1; }
            message M {
                int64 n = 1;
                Color c = 2;
                map<string, int32> counts = 3;
                string name = 4;
            }
            service S {
                rpc x(E.M) returns(E.M);
                rpc watch(E.M) returns(stream E.M);
            }`);
    });

    const ts = () => factory.exportTS('E.S');

    it('does not fail on a schema containing an enum', () => {
        expect(() => ts()).not.toThrow();
    });

    it('declares an enum field as the strings the decoder returns', () => {
        expect(ts()).toMatch(/export type IColor = \('RED' \| 'BLUE'\);/);
        expect(ts()).toMatch(/c\?: \(IColor \| null\);/);
    });

    it('declares a 64-bit field as a string, not a number', () => {
        expect(ts()).toMatch(/n\?: \(string \| null\);/);
    });

    it('declares a map field as a record, not a bare value', () => {
        expect(ts()).toMatch(/counts\?: \(Record<string, number> \| null\);/);
    });

    it('declares a server-streaming method as an async iterable', () => {
        expect(ts()).toMatch(/watch\(request: IM\): AsyncIterable<IM>;/);
        expect(ts()).toMatch(/x\(request: IM\): Promise<IM>;/);
    });
});
