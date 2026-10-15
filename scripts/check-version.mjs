import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml').match(
  /\[package\]\s[\s\S]*?^version = "([^"]+)"/m,
);
const cargoLock = read('src-tauri/Cargo.lock').match(
  /\[\[package\]\]\nname = "bindaas"\nversion = "([^"]+)"/,
);
for (const [file, version] of [
  ['package-lock.json', lock.version],
  ['package-lock.json root package', lock.packages[''].version],
  ['src-tauri/tauri.conf.json', tauri.version],
  ['src-tauri/Cargo.toml', cargo?.[1]],
  ['src-tauri/Cargo.lock', cargoLock?.[1]],
]) {
  assert.equal(version, pkg.version, `${file} must match package.json`);
}
if (process.argv[2]) {
  assert.equal(
    process.argv[2],
    `v${pkg.version}`,
    'Release tag must match the app version',
  );
}
console.log(`All app versions match v${pkg.version}`);
