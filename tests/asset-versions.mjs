import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// A release uses one query version throughout its local module graph. The
// browser caches module URLs independently, so an unversioned dependency can
// otherwise retain an old implementation after index.html has been updated.
const index = await readFile('index.html', 'utf8');
const indexRefs = [...index.matchAll(/(?:href|src)="(\.\/(?:styles\.css|trace-panel\.css|app\.js)\?v=[^"]+)"/g)].map(x => x[1]);
assert.equal(indexRefs.length, 3, 'version both stylesheets and the entry module');
for (const name of ['styles.css', 'trace-panel.css', 'app.js']) {
  assert.equal(indexRefs.filter(ref => ref.startsWith(`./${name}?v=`)).length, 1, `version ${name} exactly once`);
}
const version = new URL(indexRefs[2], 'https://example.test/').searchParams.get('v');
assert.ok(version);
for (const ref of indexRefs) assert.equal(new URL(ref, 'https://example.test/').searchParams.get('v'), version);

const visited = new Set();
const references = new Map();
async function inspect(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(/\bfrom\s+['"](\.\/[^'"]+\.js(?:\?[^'"]*)?)['"]/g)) {
    const ref = match[1], url = new URL(ref, 'https://example.test/');
    assert.equal(url.searchParams.get('v'), version, `${path}: ${ref} must use the release version`);
    assert.equal([...url.searchParams].length, 1, `${path}: unexpected module query`);
    const target = resolve(dirname(path), url.pathname.slice(1));
    await access(target);
    if (!references.has(target)) references.set(target, new Set());
    references.get(target).add(ref);
    await inspect(target);
  }
}
await inspect(resolve('app.js'));
for (const name of ['inference.js', 'resumable-cache.js']) {
  const refs = references.get(resolve(name));
  assert.ok(refs, `${name} should be reachable`);
  assert.equal(refs.size, 1, `${name} must have one URL to preserve shared state`);
}
const app = await readFile('app.js', 'utf8');
const profiler = await readFile('profiling-ui.js', 'utf8');
assert.equal(app.match(/from\s+'(\.\/inference\.js[^']*)'/)?.[1], profiler.match(/from\s+'(\.\/inference\.js[^']*)'/)?.[1], 'app and profiler use the same inference singleton');
const inferenceUrl = new URL(`../inference.js?v=${version}`, import.meta.url);
const first = await import(inferenceUrl.href);
const second = await import(inferenceUrl.href);
assert.strictEqual(first, second, 'the exact production module URL shares one instance');
console.log('PASS versioned local asset graph and shared module identities');
