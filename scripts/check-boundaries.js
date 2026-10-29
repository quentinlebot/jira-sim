#!/usr/bin/env node
// Checks the import rules of src/ and exits 1 on any violation.
// Direct imports only: with these rules the server's closure cannot reach the CLI, the mongodb driver or the pg driver,
// and `jira-sim ask` (ask.ts) stays a REST client: it never loads the server or a storage.
// Plain node, no dependencies: it runs first in npm run compile.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');

// import … from 'x', export … from 'x', import 'x', import('x'), require('x').
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

const rel = (p) => path.relative(src, p).split(path.sep).join('/');

// Why a file may not import a specifier, or null when it may.
function violation(file, spec) {
  const from = rel(file);
  if (!spec.startsWith('.')) {
    if (spec === 'vscode') return 'the simulator never imports vscode: it runs outside VS Code';
    if (spec === 'mongodb' && from !== 'mongoStorage.ts') return 'only mongoStorage.ts may import mongodb';
    if (spec === 'pg' && from !== 'postgresStorage.ts') return 'only postgresStorage.ts may import pg';
    return null;
  }
  const target = rel(path.resolve(path.dirname(file), spec));
  if (target.startsWith('..')) return 'imports outside src/';
  if (['mongoStorage', 'postgresStorage'].includes(target) && from !== 'cli.ts') return 'only cli.ts may load the database storages';
  if (target === 'cli') return 'nothing may import the CLI';
  if (target === 'ask' && from !== 'cli.ts') return 'only cli.ts may load ask.ts';
  if (from === 'ask.ts' && !['jiraFormat', 'types'].includes(target)) return 'ask.ts imports jiraFormat and types only: it is a REST client';
  return null;
}

const problems = [];
for (const file of files(src)) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(SPECIFIER)) {
      const why = violation(file, m[1]);
      if (why) problems.push(`src/${rel(file)}:${i + 1}: '${m[1]}': ${why}`);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`check-boundaries: ${problems.length} violation(s)`);
  process.exit(1);
}
console.log('check-boundaries: ok');