'use strict';

// A ratchet on file length, the same one MapleProcure runs. Past a few hundred lines nobody reads
// a file whole, and each module here is meant to be read whole inside one n8n Code node. Raising
// the cap is allowed, as a deliberate, reviewable change to MAX_LINES.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAX_LINES = 250;
const ROOT = path.resolve(__dirname, '../../..');
const SEARCH_DIRS = ['workflows/code', 'evaluation', 'database'];
const EXTENSIONS = new Set(['.js', '.py', '.sql']);
const SKIP = new Set(['node_modules', '.venv', '__pycache__']);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP.has(entry.name) ? [] : sourceFiles(full);
    }
    return EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

const files = SEARCH_DIRS.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));

test(`no source file exceeds ${MAX_LINES} lines`, () => {
  const oversized = Object.fromEntries(files
    .map((file) => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8').split('\n').length])
    .filter(([, lines]) => lines > MAX_LINES));
  assert.deepEqual(oversized, {},
    `Split the module, or raise MAX_LINES deliberately in ${path.relative(ROOT, __filename)}.`);
});

test('the cap is actually checking files in every language', () => {
  const extensions = new Set(files.map((file) => path.extname(file)));
  assert.ok(files.length >= 10, `only ${files.length} files found`);
  assert.deepEqual([...extensions].sort(), ['.js', '.sql']
    .concat(extensions.has('.py') ? ['.py'] : []).sort());
});
