import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Asserts the exact contents of the tarball npm would publish, so a secret or
 * an unintended file fails the build rather than shipping. `npm pack
 * --dry-run` only prints its manifest; nothing reads it unless a test does.
 *
 * package.json "files" is the real allowlist; .npmignore is defence in depth.
 * Both are exercised here because the tarball is what actually ships.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Paths that may appear in the tarball, as anchored patterns. */
const ALLOWED = [
    /^package\.json$/,
    /^README\.md$/,
    /^CHANGELOG\.md$/,
    /^LICENSE$/,
    /^dist\/(?!test\/).+/,
];

/** Patterns that must never ship, regardless of the allowlist. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /(^|\/)\.env($|\..*)/, why: 'environment file (may contain credentials)' },
    { pattern: /(^|\/)\.npmrc$/, why: 'npm credentials' },
    { pattern: /\.pem$/, why: 'private key or certificate' },
    { pattern: /\.key$/, why: 'private key' },
    { pattern: /(^|\/)\.github\//, why: 'CI configuration' },
    { pattern: /(^|\/)\.claude\//, why: 'local tooling config' },
    { pattern: /^dist\/test\//, why: 'compiled tests' },
    { pattern: /^test\//, why: 'test sources' },
    { pattern: /^sample\//, why: 'sample sources' },
    { pattern: /(^|\/)docker-compose\.ya?ml$/, why: 'local dev infrastructure' },
];

function packedFiles(): string[] {
    // --dry-run so nothing is written; --json for a stable, parseable manifest.
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        // npm writes its human-readable notice stream to stderr; keep it out.
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    return parsed[0].files.map((f: { path: string }) => f.path);
}

describe('published package contents', () => {
    let files: string[];

    beforeAll(() => {
        // The manifest is only meaningful against a built tree — without dist/
        // the allowlist checks would pass for the wrong reason.
        if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.js'))) {
            throw new Error(
                'dist/ is not built, so the packed manifest would be misleading. ' +
                'Run `npm run build` before this suite (CI does this in the package job).',
            );
        }
        files = packedFiles();
    }, 120000);

    it('produces a non-empty manifest', () => {
        // Guards the rest of the suite: an empty list would make every
        // "contains no secrets" assertion below vacuously true.
        expect(files.length).toBeGreaterThan(0);
        expect(files).toContain('package.json');
    });

    it.each(FORBIDDEN)('never ships $why', ({ pattern }) => {
        const offenders = files.filter(f => pattern.test(f));
        expect(offenders).toEqual([]);
    });

    it('ships nothing outside the allowlist', () => {
        const unexpected = files.filter(f => !ALLOWED.some(rule => rule.test(f)));
        expect(unexpected).toEqual([]);
    });

    it('ships the built entry point', () => {
        expect(files).toContain('dist/index.js');
        expect(files).toContain('dist/index.d.ts');
    });
});
