// Compares two style snapshots from `npm run styles:snapshot`. Exits non-zero and
// lists the first differences when any element's computed style changed.
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('Usage: node scripts/style-diff.mjs before.json after.json');
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
const differences = [];
for (const state of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const a = before[state] ?? {};
  const b = after[state] ?? {};
  for (const element of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[element] || !b[element]) {
      differences.push(`${state} ${element}: element added or removed`);
      continue;
    }
    for (const property of new Set([
      ...Object.keys(a[element]),
      ...Object.keys(b[element]),
    ]))
      if (a[element][property] !== b[element][property])
        differences.push(
          `${state} ${element.slice(-80)} ${property}: ${a[element][property]} → ${b[element][property]}`,
        );
  }
}
if (!differences.length) {
  console.log('No computed-style differences.');
} else {
  console.log(`${differences.length} differences:`);
  for (const line of differences.slice(0, 40)) console.log(`  ${line}`);
  process.exit(1);
}
