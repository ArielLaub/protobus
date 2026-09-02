import * as fs from 'fs';
import * as path from 'path';

/**
 * Every error class the library exports must set `this.name`.
 *
 * `class Foo extends Error {}` leaves `name` inherited from `Error.prototype`,
 * so `new Foo().name` is the literal string `'Error'`. That is not cosmetic:
 * `safeErrorSummary()` reads `err.name` first, and it is what lands in the
 * `x-last-error` header of every retried and dead-lettered message. An
 * operator reading a DLQ sees `Error` for a whole class of distinct failures,
 * with no way to tell them apart — the header exists to classify, and an
 * unnamed class silently defeats it.
 *
 * Discovered by scanning the source rather than listed by hand, so a class
 * added later is covered without anyone remembering to add it here.
 */

const LIB = path.resolve(__dirname, '..', '..', 'lib');

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { out.push(...sourceFiles(full)); }
        else if (entry.name.endsWith('.ts')) { out.push(full); }
    }
    return out;
}

interface Declared { file: string; name: string; base: string }

function declaredClasses(): Declared[] {
    const found: Declared[] = [];
    for (const file of sourceFiles(LIB)) {
        const src = fs.readFileSync(file, 'utf8');
        const re = /export class (\w+) extends ([\w.<>]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            found.push({ file, name: m[1], base: m[2] });
        }
    }
    return found;
}

/** Classes that are Error subclasses, transitively. */
function errorClasses(): Declared[] {
    const all = declaredClasses();
    const isError = new Set<string>(['Error']);
    // Fixpoint: a class extending a known error base is itself an error base.
    for (let changed = true; changed;) {
        changed = false;
        for (const c of all) {
            if (!isError.has(c.name) && isError.has(c.base)) {
                isError.add(c.name);
                changed = true;
            }
        }
    }
    return all.filter((c) => isError.has(c.name));
}

describe('exported error classes carry their own name', () => {
    const classes = errorClasses();

    it('found the error classes to check', () => {
        // A guard on the scanner itself: if the regex stops matching, every
        // case below would pass vacuously.
        expect(classes.length).toBeGreaterThan(20);
        expect(classes.map((c) => c.name)).toContain('ReconnectionError');
        expect(classes.map((c) => c.name)).toContain('DisconnectedError');
        expect(classes.map((c) => c.name)).toContain('MissingProto');
    });

    it.each(classes.map((c) => [c.name, c.file] as [string, string]))(
        '%s sets this.name',
        (name, file) => {
            const mod = require(file.replace(/\.ts$/, ''));
            const Cls = mod[name];
            expect(typeof Cls).toBe('function');
            const instance = new Cls('probe message');
            expect(instance.name).toBe(name);
        },
    );
});
