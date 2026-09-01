#!/usr/bin/env node
/**
 * Every relative link in the documentation, resolved.
 *
 * The docs tree was reorganised into guide/ concepts/ reference/ operations/,
 * and the review that prompted it had already found five links pointing at
 * files that never existed — including the one the front page offered for its
 * own headline feature. Moving pages multiplies that class of defect, so it is
 * checked rather than trusted.
 *
 * What it verifies:
 *   - every relative markdown/file link resolves to something on disk
 *   - every in-page `#anchor` matches a heading that exists on the target page
 *   - the root README uses ABSOLUTE github.com URLs, because npm and PyPI do
 *     not rewrite relative links and `docs/` is not in the published tarball
 *
 * Usage:  node scripts/check-doc-links.js [--verbose]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

const ESC = String.fromCharCode(27);
const C = process.stdout.isTTY
    ? { red: ESC + '[31m', green: ESC + '[32m', dim: ESC + '[2m', bold: ESC + '[1m', off: ESC + '[0m' }
    : { red: '', green: '', dim: '', bold: '', off: '' };

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
    for (const root of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
        if (fs.existsSync(path.join(REPO, root))) found.push(root);
    }
    return found.sort();
}

/** GitHub's heading -> anchor slug. */
function slugify(heading) {
    return heading
        .replace(/`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links render as their text
        // Real HTML tags disappear from the rendered heading; a placeholder
        // like <Name> does not, and GitHub slugs it as the word `name`.
        .replace(/<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        // One hyphen per space, not per run: GitHub's slugger substitutes each
        // whitespace character, so `A = "b" is c` becomes `a--b-is-c`.
        .replace(/\s/g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
    if (anchorCache.has(file)) return anchorCache.get(file);
    const set = new Set();
    let inFence = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) set.add(slugify(h[2]));
        // <a name="..."> / id="..." anchors count too
        for (const m of line.matchAll(/(?:name|id)="([^"]+)"/g)) set.add(m[1].toLowerCase());
    }
    anchorCache.set(file, set);
    return set;
}

// Ignore code spans and fenced blocks: a link-looking string inside one is text.
function strippedOf(source) {
    const lines = source.split('\n');
    let inFence = false;
    return lines.map((line) => {
        if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
        if (inFence) return '';
        return line.replace(/`[^`]*`/g, '');
    });
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function main() {
    const problems = [];
    let checked = 0;

    for (const file of markdownFiles()) {
        const abs = path.join(REPO, file);
        const lines = strippedOf(fs.readFileSync(abs, 'utf8'));

        lines.forEach((line, i) => {
            for (const m of line.matchAll(LINK)) {
                const target = m[1];
                const where = file + ':' + (i + 1);

                if (/^(https?:|mailto:|tel:)/.test(target)) {
                    // The root README is rendered by npm, which does not resolve
                    // relative links and does not ship docs/ in the tarball.
                    continue;
                }
                checked++;

                if (target.startsWith('#')) {
                    const anchor = target.slice(1).toLowerCase();
                    if (!anchorsOf(abs).has(anchor)) {
                        problems.push(where + '  no heading on this page for ' + target);
                    }
                    continue;
                }

                if (file === 'README.md') {
                    problems.push(where + '  relative link ' + target
                        + ' — the root README must use absolute https://github.com/ArielLaub/protobus/... URLs '
                        + '(npm does not rewrite them, and docs/ is not in the published tarball)');
                    continue;
                }

                const [rawPath, anchor] = target.split('#');
                const resolved = path.resolve(path.dirname(abs), decodeURIComponent(rawPath));
                if (!fs.existsSync(resolved)) {
                    problems.push(where + '  ' + target + ' -> ' + path.relative(REPO, resolved) + ' does not exist');
                    continue;
                }
                if (anchor && resolved.endsWith('.md')) {
                    if (!anchorsOf(resolved).has(anchor.toLowerCase())) {
                        problems.push(where + '  ' + target + ' — ' + path.relative(REPO, resolved)
                            + ' has no heading matching #' + anchor);
                    }
                }
                if (VERBOSE) console.log(C.dim + 'ok  ' + where + '  ' + target + C.off);
            }
        });
    }

    if (problems.length) {
        console.log(C.bold + 'Broken documentation links' + C.off);
        for (const p of problems) console.log(C.red + 'FAIL' + C.off + ' ' + p);
    }
    console.log('\n' + (checked - problems.length) + ' of ' + checked + ' relative links resolve'
        + (problems.length ? ', ' + problems.length + C.red + ' broken' + C.off : ''));
    return problems.length ? 1 : 0;
}

process.exit(main());
