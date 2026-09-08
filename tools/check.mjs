/* Parse every source module with the real JS parser and report syntax errors. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|assets[\\/]lib|\.git|qa/.test(f)) walk(f); }
    else if (/\.(js|mjs)$/.test(e.name)) files.push(f);
  }
})(ROOT);

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
  } catch (e) {
    bad++;
    console.error(`\n✗ ${path.relative(ROOT, f)}\n  ${e.message}`);
    const m = /(\d+)\n/.exec(e.stack || '');
    const lm = /:(\d+)$/.exec((e.stack || '').split('\n')[0] || '');
    if (lm) console.error('  line ' + lm[1]);
  }
}
console.log(bad ? `\n${bad} file(s) failed to parse.` : `\n✓ all ${files.length} modules parse.`);
process.exit(bad ? 1 : 0);
