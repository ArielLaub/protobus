#!/usr/bin/env node
/**
 * Every Mermaid diagram in the docs, rendered.
 *
 * GitHub renders ```mermaid blocks natively, and a diagram with a syntax error
 * renders as a red error box on the page rather than failing anywhere a writer
 * would notice. The ASCII art these replaced could at least never be "broken",
 * so this restores that property: each block is parsed by the real mermaid
 * library in a headless browser and must produce an SVG.
 *
 * Usage:  node scripts/check-mermaid.js [--verbose]
 *
 * Requires a Chromium that Playwright can drive. Skips with a clear message if
 * there is none, so it does not become a barrier on a machine without one.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const MERMAID_VERSION = '11.17.2';

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
    if (fs.existsSync(path.join(REPO, 'README.md'))) found.push('README.md');
    return found.sort();
}

function collect() {
    const blocks = [];
    for (const file of markdownFiles()) {
        const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!/^\s*```mermaid\s*$/.test(lines[i])) continue;
            const body = [];
            let j = i + 1;
            for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j]);
            blocks.push({ file, line: i + 1, source: body.join('\n') });
            i = j;
        }
    }
    return blocks;
}

async function main() {
    const blocks = collect();
    if (!blocks.length) { console.log('no mermaid diagrams found'); return 0; }

    // npm's README is rendered by a pipeline that does not know mermaid; a
    // diagram there shows as raw fenced text on the package page.
    const inReadme = blocks.filter((b) => b.file === 'README.md');
    if (inReadme.length) {
        for (const b of inReadme) {
            console.log('FAIL ' + b.file + ':' + b.line
                + '  mermaid in the root README — npm and PyPI render it as raw text. Keep diagrams in docs/.');
        }
        return 1;
    }

    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        console.log('SKIP: playwright is not installed here, so ' + blocks.length
            + ' diagram(s) were not rendered. Install it, or rely on the CI job.');
        return 0;
    }

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="host"></div></body></html>');
    await page.addScriptTag({
        url: 'https://cdn.jsdelivr.net/npm/mermaid@' + MERMAID_VERSION + '/dist/mermaid.min.js',
    });
    await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false }));

    let failures = 0;
    for (const [index, b] of blocks.entries()) {
        const result = await page.evaluate(async ([source, id]) => {
            try {
                await window.mermaid.parse(source);
                const { svg } = await window.mermaid.render('d' + id, source);
                return { ok: svg.includes('<svg') && !svg.includes('aria-roledescription="error"'), svg: svg.length };
            } catch (e) {
                return { ok: false, error: String(e && e.message ? e.message : e) };
            }
        }, [b.source, index]);

        if (result.ok) {
            if (VERBOSE) console.log('PASS ' + b.file + ':' + b.line + '  (' + result.svg + ' bytes of SVG)');
        } else {
            failures++;
            console.log('FAIL ' + b.file + ':' + b.line + '\n      ' + (result.error || 'rendered an error diagram'));
        }
    }

    await browser.close();
    console.log('\n' + (blocks.length - failures) + ' of ' + blocks.length
        + ' mermaid diagrams render with mermaid ' + MERMAID_VERSION);
    return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
