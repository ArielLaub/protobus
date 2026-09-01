#!/usr/bin/env node
/**
 * Executes the documentation.
 *
 * Every claim-bearing code block in README.md and docs/ carries a directive
 * comment saying how it should be checked, and this script does the checking:
 * .proto blocks are parsed, TypeScript blocks are type-checked against the
 * library's own declarations, and blocks marked `run` are compiled and executed
 * against a live broker with their documented output asserted.
 *
 * It exists because a documentation review executed every runnable example in
 * the set and found nine that did not do what they said - three of which ran
 * cleanly and silently produced the wrong result. Reading cannot catch those.
 * This can, and it fails the build when it does.
 *
 * Usage:
 *   node scripts/check-doc-snippets.js              # everything
 *   node scripts/check-doc-snippets.js --no-broker  # skip blocks needing RabbitMQ
 *   node scripts/check-doc-snippets.js --list       # coverage report, no execution
 *   node scripts/check-doc-snippets.js docs/guide   # limit to a path prefix
 *
 * Env:
 *   AMQP_URL       broker for `run` blocks (default amqp://guest:guest@localhost:5672/)
 *   RABBITMQ_MGMT  management API base for queue cleanup (default http://localhost:15672)
 *
 * ---------------------------------------------------------------------------
 * Directive syntax, in an HTML comment immediately above the fence (HTML
 * comments do not render on GitHub, npm or PyPI, so the page is unaffected):
 *
 *   <!-- doc-check: MODE key=value key="value with spaces" flag -->
 *
 * Modes:
 *   proto     write the block to the sandbox and parse it with protobufjs
 *   compile   type-check the block against the built library
 *   run       compile, execute, require exit 0 within the timeout
 *   daemon    compile, execute in the background for sibling `run` blocks
 *   ignore    deliberately unchecked - takes a `why=` and is reported as such
 *
 * Keys:
 *   id=NAME          name this block so others can refer to it
 *   needs=A,B        prepend those blocks' sources (shared imports, a class
 *                    defined in an earlier step)
 *   file=PATH        proto mode: write it here, relative to the sandbox, so
 *                    `run` blocks can load it. Without this the schema is only
 *                    parsed for syntax and is not visible to any snippet.
 *   expect=TEXT      require TEXT in the block's combined output (repeatable)
 *   forbid=TEXT      fail if TEXT appears in the output (repeatable) - this is
 *                    what catches a snippet that runs clean and does nothing
 *   with=ID[,ID]     run mode: start those daemons first, stop them after
 *   ready=TEXT       daemon mode: consider the daemon up once TEXT is printed
 *   broker           this block needs RabbitMQ
 *   timeout=MS       default 30000 for run, 20000 for a daemon's readiness
 *   env=K=V          extra environment variable (repeatable)
 *   why=TEXT         ignore mode: why it is not checked
 *
 * A `run` block that never exits is a failure. That is deliberate: a client
 * example the reader copies has to terminate, and one of the nine defects was
 * a documented client that hangs forever with no close() anywhere in the set.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SANDBOX = path.join(REPO, '.doc-check');
const SRC = path.join(SANDBOX, 'src');
const OUT = path.join(SANDBOX, 'out');
const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
const MGMT = process.env.RABBITMQ_MGMT || 'http://localhost:15672';

const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes('--list');
const NO_BROKER = argv.includes('--no-broker');
const VERBOSE = argv.includes('--verbose');
const PREFIXES = argv.filter((a) => !a.startsWith('--'));

const ESC = String.fromCharCode(27);
const C = process.stdout.isTTY
    ? {
        red: ESC + '[31m', green: ESC + '[32m', yellow: ESC + '[33m',
        dim: ESC + '[2m', bold: ESC + '[1m', off: ESC + '[0m',
    }
    : { red: '', green: '', yellow: '', dim: '', bold: '', off: '' };

// ---------------------------------------------------------------------------
// Discovery

function markdownFiles() {
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.md')) found.push(path.relative(REPO, full));
        }
    };
    walk(path.join(REPO, 'docs'));
    for (const rootDoc of ['README.md', 'CONTRIBUTING.md']) {
        if (fs.existsSync(path.join(REPO, rootDoc))) found.push(rootDoc);
    }
    return found
        .filter((f) => PREFIXES.length === 0 || PREFIXES.some((p) => f.startsWith(p)))
        .sort();
}

const DIRECTIVE = /^<!--\s*doc-check:\s*(.+?)\s*-->\s*$/;
const FENCE = /^(\s*)```([A-Za-z0-9_+-]*)\s*$/;

/** Tokenise `mode k=v k="v v" flag` without a real parser. */
function parseDirective(text) {
    const tokens = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const spec = { mode: tokens[0], expect: [], forbid: [], env: {}, flags: new Set() };
    for (const tok of tokens.slice(1)) {
        const eq = tok.indexOf('=');
        if (eq === -1) { spec.flags.add(tok); continue; }
        const key = tok.slice(0, eq);
        let value = tok.slice(eq + 1);
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (key === 'file') spec.writePath = value;   // not `file`: that is the markdown page
        else if (key === 'expect') spec.expect.push(value);
        else if (key === 'forbid') spec.forbid.push(value);
        else if (key === 'env') {
            const vEq = value.indexOf('=');
            spec.env[value.slice(0, vEq)] = value.slice(vEq + 1);
        } else spec[key] = value;
    }
    return spec;
}

function collectBlocks() {
    const blocks = [];
    const unchecked = [];
    for (const file of markdownFiles()) {
        const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
        let pending = null;
        for (let i = 0; i < lines.length; i++) {
            const dm = DIRECTIVE.exec(lines[i]);
            if (dm) { pending = { spec: parseDirective(dm[1]), directiveLine: i + 1 }; continue; }
            const fm = FENCE.exec(lines[i]);
            if (!fm) { if (pending && lines[i].trim() !== '') pending = null; continue; }

            const indent = fm[1];
            const lang = fm[2];
            const body = [];
            const close = new RegExp('^' + indent + '```\\s*$');
            let j = i + 1;
            for (; j < lines.length; j++) {
                if (close.test(lines[j])) break;
                body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
            }
            const source = body.join('\n');
            const checkable = ['typescript', 'ts', 'protobuf', 'proto'].includes(lang);
            if (pending) {
                blocks.push(Object.assign({ file, line: i + 1, lang, source }, pending.spec));
            } else if (checkable) {
                unchecked.push({ file, line: i + 1, lang, lines: body.length });
            }
            pending = null;
            i = j;
        }
    }
    return { blocks, unchecked };
}

// ---------------------------------------------------------------------------
// Sandbox

function ensureLinkedPackage() {
    // `import ... from 'protobus'` inside the sandbox has to resolve to this
    // working tree's build, not to a published copy. Node resolves bare
    // specifiers by walking up, so a self-link in the repo's own node_modules
    // makes .doc-check/src/*.ts resolve to dist/ via package.json "main".
    const link = path.join(REPO, 'node_modules', 'protobus');
    try {
        if (fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(REPO)) return;
        fs.rmSync(link, { recursive: true, force: true });
    } catch { /* not there yet */ }
    fs.symlinkSync(REPO, link, 'dir');
}

function ensureBuilt() {
    if (fs.existsSync(path.join(REPO, 'dist', 'index.d.ts'))) return;
    console.log(C.dim + '==> dist/ missing, building the library first' + C.off);
    const r = spawnSync('npm', ['run', 'build-ts'], { cwd: REPO, stdio: 'inherit' });
    if (r.status !== 0) { console.error('build failed'); process.exit(1); }
}

const TSCONFIG = {
    compilerOptions: {
        module: 'commonjs',
        target: 'ES2022',
        moduleResolution: 'node',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        // The snippets are checked, not the library's own declarations - a
        // @types clash in a transitive dependency is not a documentation bug.
        skipLibCheck: true,
        noImplicitAny: false,
        strict: false,
        forceConsistentCasingInFileNames: true,
        sourceMap: false,
        outDir: 'out',
        rootDir: 'src',
        lib: ['ES2022', 'dom'],
        types: ['node'],
    },
    include: ['src/**/*'],
};

const IMPORT_RE = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+['"][^'"]+['"];?[ \t]*$|^import\s+['"][^'"]+['"];?[ \t]*$/gm;

/**
 * A snippet written for a reader uses top-level await; the CommonJS project the
 * CLI scaffolds cannot have it. The docs now tell the reader to wrap it in an
 * async main(), and this wraps it the same way before checking.
 */
function prepare(source) {
    const SENTINEL = '/*__doc_check_import__*/';
    const raw = [];
    const stripped = source.replace(IMPORT_RE, (m) => {
        raw.push(m.replace(/;?[ \t]*$/, ';'));
        return SENTINEL;
    });

    // A relative import can never resolve in the sandbox: every block becomes
    // one flat file. Blocks that genuinely depend on an earlier step declare it
    // with `needs=`, which inlines that block's source, so `import { x } from
    // './context'` is already satisfied and only gets in the way. A block that
    // forgot its `needs=` fails type-checking with "Cannot find name", which is
    // exactly the diagnostic its author wants.
    const named = new Map();
    const other = [];
    for (const stmt of raw) {
        const mod = /from\s+(['"][^'"]+['"])/.exec(stmt);
        if (mod && /^['"]\.{1,2}\//.test(mod[1])) continue;
        const flat = stmt.replace(/\s+/g, ' ').trim();
        const braced = /^import\s+\{([^}]*)\}\s+from\s+(['"][^'"]+['"]);$/.exec(flat);
        if (braced) {
            if (!named.has(braced[2])) named.set(braced[2], new Set());
            for (const n of braced[1].split(',').map((x) => x.trim()).filter(Boolean)) named.get(braced[2]).add(n);
        } else if (!other.includes(stmt)) {
            other.push(stmt);
        }
    }
    const imports = other.concat(
        [...named].map(([mod, names]) => 'import { ' + [...names].join(', ') + ' } from ' + mod + ';')
    );

    const body = stripped.split('\n').filter((l) => l.trim() !== SENTINEL).join('\n');
    const unindented = body.split('\n').filter((l) => !/^\s/.test(l)).join('\n');
    const topLevelAwait = /(^|[\s=(,[])await\s/.test(unindented);
    if (!topLevelAwait) return imports.join('\n') + '\n' + body + '\n';
    const indented = body.split('\n').map((l) => (l.trim() === '' ? '' : '    ' + l)).join('\n');
    return [
        imports.join('\n'),
        '',
        'async function __main(): Promise<void> {',
        indented,
        '}',
        '__main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });',
        '',
    ].join('\n');
}

function slug(block) {
    return block.file.replace(/[^A-Za-z0-9]+/g, '_') + '__L' + block.line;
}

// ---------------------------------------------------------------------------
// Broker helpers

function brokerReachable() {
    if (NO_BROKER) return Promise.resolve(false);
    const net = require('net');
    const url = new URL(AMQP_URL);
    return new Promise((resolve) => {
        const sock = net.connect({ host: url.hostname, port: Number(url.port || 5672) }, () => {
            sock.destroy(); resolve(true);
        });
        sock.on('error', () => resolve(false));
        sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
    });
}

async function listQueues() {
    // Best effort: without the management plugin the snippets still run, they
    // just leave their queues for the next `docker compose down`.
    try {
        const auth = Buffer.from('guest:guest').toString('base64');
        const res = await fetch(MGMT + '/api/queues/%2F', { headers: { Authorization: 'Basic ' + auth } });
        if (!res.ok) return null;
        return (await res.json()).map((q) => q.name);
    } catch { return null; }
}

async function deleteQueues(names) {
    const auth = Buffer.from('guest:guest').toString('base64');
    for (const name of names) {
        try {
            await fetch(MGMT + '/api/queues/%2F/' + encodeURIComponent(name), {
                method: 'DELETE', headers: { Authorization: 'Basic ' + auth },
            });
        } catch { /* leave it; the compose teardown will */ }
    }
}

// ---------------------------------------------------------------------------
// Execution

function runNode(file, spec) {
    const timeout = Number(spec.timeout || 30000);
    const r = spawnSync(process.execPath, [file], {
        cwd: SANDBOX,
        timeout,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AMQP_URL }, spec.env),
    });
    return {
        status: r.status,
        signal: r.signal,
        timedOut: Boolean(r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM')),
        output: (r.stdout || '') + (r.stderr || ''),
    };
}

function startDaemon(file, spec) {
    const child = spawn(process.execPath, [file], {
        cwd: SANDBOX,
        env: Object.assign({}, process.env, { AMQP_URL }, spec.env),
    });
    const state = { text: '' };
    child.stdout.on('data', (d) => { state.text += d; });
    child.stderr.on('data', (d) => { state.text += d; });
    const ready = new Promise((resolve, reject) => {
        const deadline = setTimeout(
            () => reject(new Error('never printed ' + JSON.stringify(spec.ready) + '; output was:\n' + state.text)),
            Number(spec.timeout || 20000)
        );
        if (!spec.ready) { clearTimeout(deadline); setTimeout(resolve, 2000); return; }
        const poll = setInterval(() => {
            if (state.text.includes(spec.ready)) { clearInterval(poll); clearTimeout(deadline); resolve(); }
            else if (child.exitCode !== null) {
                clearInterval(poll); clearTimeout(deadline);
                reject(new Error('exited early with ' + child.exitCode + ':\n' + state.text));
            }
        }, 100);
    });
    return { child, ready, state };
}

// ---------------------------------------------------------------------------

async function main() {
    const { blocks, unchecked } = collectBlocks();

    if (LIST_ONLY) {
        const byMode = {};
        for (const b of blocks) byMode[b.mode] = (byMode[b.mode] || 0) + 1;
        console.log(C.bold + 'Checked blocks' + C.off);
        for (const [mode, n] of Object.entries(byMode).sort()) console.log('  ' + mode.padEnd(8) + ' ' + n);
        console.log('\n' + C.bold + 'Untagged code blocks (' + unchecked.length + ')' + C.off);
        for (const u of unchecked) console.log('  ' + C.dim + u.file + ':' + u.line + C.off + ' ' + u.lang + ' (' + u.lines + ' lines)');
        return 0;
    }

    ensureBuilt();
    ensureLinkedPackage();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(SRC, { recursive: true });
    fs.writeFileSync(path.join(SANDBOX, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 4));
    fs.writeFileSync(path.join(SANDBOX, 'package.json'), JSON.stringify({ name: 'doc-check-sandbox', private: true }, null, 4));

    const results = [];
    const byId = new Map();
    for (const b of blocks) if (b.id) byId.set(b.id, b);

    const pass = (b, note) => results.push({ b, ok: true, note });
    const fail = (b, why) => results.push({ b, ok: false, why });

    // --- proto blocks -------------------------------------------------------
    const protobuf = require(path.join(REPO, 'node_modules', 'protobufjs'));
    for (const b of blocks.filter((x) => x.mode === 'proto')) {
        // Without an explicit `file=`, a schema is only checked for syntax: it
        // lands in a directory no snippet loads, so two pages showing the same
        // package cannot collide with `duplicate name` at runtime. Give a block
        // `file=proto/X.proto` when a `run` block must actually load it.
        const rel = b.writePath || ('schemas-checked/' + slug(b) + '.proto');
        const dest = path.join(SANDBOX, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, b.source + '\n');
        try {
            protobuf.parse(b.source, new protobuf.Root(), { keepCase: true });
            pass(b, 'parses, written to ' + rel);
        } catch (e) {
            fail(b, 'protobufjs rejected it: ' + e.message);
        }
    }

    // --- typescript blocks --------------------------------------------------
    const tsBlocks = blocks.filter((x) => ['compile', 'run', 'daemon'].includes(x.mode));
    const fileFor = new Map();
    for (const b of tsBlocks) {
        const parts = [];
        for (const dep of String(b.needs || '').split(',').filter(Boolean)) {
            const src = byId.get(dep);
            if (!src) { fail(b, 'needs=' + dep + ' names no block with that id'); continue; }
            parts.push('// ---- from ' + src.file + ':' + src.line + ' (needs=' + dep + ') ----', src.source);
        }
        parts.push(b.source);
        const name = slug(b) + '.ts';
        fs.writeFileSync(path.join(SRC, name), prepare(parts.join('\n\n')));
        fileFor.set(b, name);
    }

    if (tsBlocks.length) {
        const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: SANDBOX, encoding: 'utf8' });
        const diagnostics = (tsc.stdout || '') + (tsc.stderr || '');
        if (tsc.status !== 0) {
            const byFile = new Map();
            for (const raw of diagnostics.split('\n')) {
                const m = /^src[\\/]([^(]+)\((\d+),(\d+)\):\s*(.+)$/.exec(raw.trim());
                if (!m) continue;
                if (!byFile.has(m[1])) byFile.set(m[1], []);
                byFile.get(m[1]).push('line ' + m[2] + ': ' + m[4]);
            }
            for (const b of tsBlocks) {
                const errs = byFile.get(fileFor.get(b));
                if (errs) fail(b, 'does not type-check:\n      ' + errs.join('\n      '));
            }
            if (byFile.size === 0) {
                console.error(C.red + 'tsc failed without a per-file diagnostic:' + C.off + '\n' + diagnostics);
                return 1;
            }
        }
    }
    // A snippet resolves its protos from __dirname, which for the compiled
    // output is out/ rather than the sandbox root, so the schemas have to exist
    // under both. Done after tsc, which creates out/.
    if (fs.existsSync(path.join(SANDBOX, 'proto')) && fs.existsSync(OUT)) {
        fs.cpSync(path.join(SANDBOX, 'proto'), path.join(OUT, 'proto'), { recursive: true });
    }

    const failedTs = new Set(results.filter((r) => !r.ok).map((r) => r.b));
    for (const b of tsBlocks.filter((x) => x.mode === 'compile' && !failedTs.has(x))) pass(b, 'type-checks');

    // --- executable blocks --------------------------------------------------
    const runnable = tsBlocks.filter((x) => x.mode === 'run' && !failedTs.has(x));
    const haveBroker = runnable.some((b) => b.flags.has('broker')) ? await brokerReachable() : false;
    const queuesBefore = haveBroker ? await listQueues() : null;

    for (const b of runnable) {
        if (b.flags.has('broker') && !haveBroker) {
            results.push({ b, ok: true, skipped: true, note: 'no broker at ' + AMQP_URL });
            continue;
        }
        const js = path.join(OUT, fileFor.get(b).replace(/\.ts$/, '.js'));
        if (!fs.existsSync(js)) { fail(b, 'tsc emitted nothing for it'); continue; }

        const daemons = [];
        let startupFailure = null;
        for (const dep of String(b.with || '').split(',').filter(Boolean)) {
            const dBlock = byId.get(dep);
            if (!dBlock) { startupFailure = 'with=' + dep + ' names no block with that id'; break; }
            const dJs = path.join(OUT, fileFor.get(dBlock).replace(/\.ts$/, '.js'));
            const d = startDaemon(dJs, dBlock);
            daemons.push(d);
            try {
                await d.ready;
            } catch (e) {
                startupFailure = 'its background block (' + dep + ') failed to start: ' + e.message;
                break;
            }
        }
        const stopDaemons = async () => {
            for (const d of daemons) d.child.kill('SIGTERM');
            await new Promise((s) => setTimeout(s, 600));
            for (const d of daemons) if (d.child.exitCode === null) d.child.kill('SIGKILL');
        };
        if (startupFailure) { await stopDaemons(); fail(b, startupFailure); continue; }

        const r = runNode(js, b);
        // Give a subscriber a moment to receive anything the client's call
        // triggered before its output is read.
        if (daemons.length) await new Promise((s) => setTimeout(s, 800));
        await stopDaemons();

        const combined = r.output + daemons.map((d) => d.state.text).join('');
        const indent = (s) => s.trim().split('\n').join('\n      ');
        if (r.timedOut) {
            fail(b, 'did not exit within ' + (b.timeout || 30000) + 'ms. A documented example the reader '
                + 'copies has to terminate - if this one is a long-running server, mark it `daemon`.\n      '
                + indent(combined));
            continue;
        }
        if (r.status !== 0) {
            fail(b, 'exited ' + r.status + (r.signal ? ' (' + r.signal + ')' : '') + ':\n      ' + indent(combined));
            continue;
        }
        const missing = b.expect.filter((e) => !combined.includes(e));
        const present = b.forbid.filter((e) => combined.includes(e));
        if (missing.length || present.length) {
            const why = missing.map((m) => 'expected ' + JSON.stringify(m) + ' in the output; it is not there')
                .concat(present.map((p) => 'output contains ' + JSON.stringify(p) + ', which it must not'));
            fail(b, 'ran clean but did not do what the page says:\n      ' + why.join('\n      ')
                + '\n      --- actual output ---\n      ' + indent(combined));
            continue;
        }
        pass(b, b.expect.length
            ? 'ran, and printed ' + b.expect.map((e) => JSON.stringify(e)).join(', ')
            : 'ran and exited 0');
        if (VERBOSE) console.log(C.dim + combined.trim() + C.off);
    }

    if (haveBroker && queuesBefore) {
        const after = await listQueues();
        const created = (after || []).filter((q) => !queuesBefore.includes(q));
        if (created.length) {
            await deleteQueues(created);
            console.log(C.dim + '==> cleaned up ' + created.length + ' queue(s) the snippets created' + C.off);
        }
    }

    // --- report -------------------------------------------------------------
    console.log();
    let failures = 0;
    let skipped = 0;
    for (const r of results) {
        const where = r.b.file + ':' + r.b.line;
        if (r.skipped) { skipped++; console.log(C.yellow + 'SKIP' + C.off + ' ' + where + ' ' + C.dim + '(' + r.note + ')' + C.off); continue; }
        if (r.ok) { console.log(C.green + 'PASS' + C.off + ' ' + where + ' ' + C.dim + r.b.mode + ' - ' + r.note + C.off); continue; }
        failures++;
        console.log(C.red + 'FAIL' + C.off + ' ' + where + ' ' + C.bold + r.b.mode + C.off + '\n      ' + r.why);
    }

    const ignored = blocks.filter((b) => b.mode === 'ignore');
    console.log('\n' + (results.length - failures - skipped) + ' passed, ' + failures + ' failed, '
        + skipped + ' skipped, ' + ignored.length + ' deliberately unchecked, '
        + unchecked.length + ' untagged code blocks');
    if (VERBOSE) for (const u of unchecked) console.log('  ' + C.dim + 'untagged: ' + u.file + ':' + u.line + ' (' + u.lang + ')' + C.off);
    return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
