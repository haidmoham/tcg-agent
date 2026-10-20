import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Assemble retained private inputs; never extract from or modify a client.
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const inside = (parent, target) => {
  const part = relative(parent, target);
  return part && !isAbsolute(part) && !part.startsWith('..');
};
try {
  const [sourcePath, outputPath, mode, ...extra] = process.argv.slice(2);
  check(sourcePath && outputPath && (!mode || mode === '--from-bundle') && !extra.length,
    'usage: node scripts/assemble-native-bundle.mjs <private-source-root> <new-.cache-output> [--from-bundle]');
  const pins = JSON.parse(readFileSync(join(root, 'integrations/local-worker/baseline-prerequisites.json')));
  const manifestBytes = readFileSync(join(root, 'integrations/local-worker/native-bundle-manifest.json'));
  check(sha(manifestBytes) === pins.manifestSha256, 'canonical-private-manifest-pin-mismatch');
  const manifest = JSON.parse(manifestBytes);
  const source = realpathSync(resolve(sourcePath));
  const cache = join(root, '.cache');
  const output = resolve(outputPath);
  check(inside(cache, output) && !existsSync(output), 'fresh-private-cache-output-required');
  // Validate every input before creating the output directory.
  const files = manifest.files.map(entry => {
    const pinned = pins.privateInputs.find(row => row.path === entry.path);
    check(pinned?.sha256 === entry.sha256 && pinned.bytes === entry.bytes, 'input-manifest-disagreement');
    const path = realpathSync(join(source, mode ? entry.path : entry.source));
    check(inside(source, path), 'private-input-outside-source-root');
    const bytes = readFileSync(path);
    check(bytes.length === entry.bytes && sha(bytes) === entry.sha256, 'private-input-pin-mismatch');
    return { name: entry.path, bytes };
  });
  check(files.length === 8, 'eight-private-inputs-required');
  mkdirSync(cache, { recursive: true });
  check(realpathSync(cache) === cache, 'cache-junction-not-supported');
  mkdirSync(output, { recursive: true });
  for (const file of files) writeFileSync(join(output, file.name), file.bytes, { flag: 'wx' });
  writeFileSync(join(output, 'manifest.json'), manifestBytes, { flag: 'wx' });
  console.log(JSON.stringify({ schema: 'native-bundle-assembly/1', files: files.length,
    manifestSha256: sha(manifestBytes), bundleId: manifest.bundleId,
    extractedFromClient: false, vendorFilesPublished: false }));
} catch (error) {
  console.error(error.code ? 'private-bundle-source-unavailable' : error.message);
  process.exitCode = 1;
}
