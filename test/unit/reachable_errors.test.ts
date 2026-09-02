import * as fs from 'fs';
import * as path from 'path';

/**
 * An exported error class no `catch` can ever match is worse than no class at
 * all: it reads as a supported outcome, so callers write branches for it that
 * are dead from the day they are written.
 *
 * A class is *reachable* if the library constructs it, or constructs any
 * subclass of it — `HandledError` is never constructed by `lib/` and is still
 * perfectly catchable, because `ProtocolError` extends it and is thrown.
 *
 * Anything unreachable must be marked `@deprecated` in the source, so the
 * dead name is at least visible as dead in an editor and in the API reference.
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

const FILES = sourceFiles(LIB);
const SOURCES = new Map(FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const ALL_SOURCE = [...SOURCES.values()].join('\n');

interface Declared { file: string; name: string; base: string }

const declared: Declared[] = [];
for (const [file, src] of SOURCES) {
    const re = /export class (\w+) extends ([\w.<>]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) { declared.push({ file, name: m[1], base: m[2] }); }
}

const isError = new Set<string>(['Error']);
for (let changed = true; changed;) {
    changed = false;
    for (const c of declared) {
        if (!isError.has(c.name) && isError.has(c.base)) { isError.add(c.name); changed = true; }
    }
}
const errorClasses = declared.filter((c) => isError.has(c.name));

/** Does `lib/` construct this class, or anything extending it? */
function constructedAnywhere(name: string, seen = new Set<string>()): boolean {
    if (seen.has(name)) return false;
    seen.add(name);
    if (new RegExp(`new ${name}\\s*\\(`).test(ALL_SOURCE)) return true;
    return errorClasses
        .filter((c) => c.base === name)
        .some((c) => constructedAnywhere(c.name, seen));
}

/** Is the declaration preceded by an `@deprecated` JSDoc tag? */
function isDeprecated(c: Declared): boolean {
    const src = SOURCES.get(c.file)!;
    const at = src.indexOf(`export class ${c.name} extends`);
    const preceding = src.slice(Math.max(0, at - 1200), at);
    const lastComment = preceding.lastIndexOf('/**');
    if (lastComment === -1) return false;
    return preceding.slice(lastComment).includes('@deprecated');
}

describe('exported error classes are reachable by a catch', () => {
    it('found the classes to check', () => {
        expect(errorClasses.length).toBeGreaterThan(20);
        // The two halves of the predicate, pinned so it cannot pass vacuously.
        expect(constructedAnywhere('ProtocolError')).toBe(true);
        expect(constructedAnywhere('HandledError')).toBe(true); // via ProtocolError
    });

    it.each(errorClasses.map((c) => [c.name, c] as [string, Declared]))(
        '%s is thrown by the library, or marked @deprecated',
        (name, c) => {
            if (constructedAnywhere(name)) return;
            expect({ name, deprecated: isDeprecated(c) })
                .toEqual({ name, deprecated: true });
        },
    );
});
