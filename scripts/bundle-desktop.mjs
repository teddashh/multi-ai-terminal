import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = resolve(root, 'server/src/index.ts');
const webDist = resolve(root, 'web/dist');
const resources = resolve(root, 'desktop/resources');
const bundledServer = resolve(resources, 'server/dist/index.js');
const bundledServerPackage = resolve(resources, 'server/dist/package.json');
const bundledRuntimeCatalog = resolve(resources, 'server/dist/runtime-catalog.json');
const bundledWeb = resolve(resources, 'web/dist');

let webDistStats;
try {
  webDistStats = await stat(webDist);
} catch {
  console.error('[desktop:bundle] web/dist is missing. Run `npm run build` first.');
  process.exit(1);
}

if (!webDistStats.isDirectory()) {
  console.error('[desktop:bundle] web/dist is not a directory. Run `npm run build` first.');
  process.exit(1);
}

await rm(resolve(resources, 'server'), { recursive: true, force: true });
await rm(resolve(resources, 'web'), { recursive: true, force: true });
await mkdir(resolve(resources, 'server/dist'), { recursive: true });

await build({
  entryPoints: [serverEntry],
  outfile: bundledServer,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  bundle: true,
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  minify: false,
  sourcemap: false,
});
await writeFile(bundledServerPackage, '{"type":"module"}', 'utf8');
await cp(resolve(root, 'runtime-catalog.json'), bundledRuntimeCatalog);

await mkdir(bundledWeb, { recursive: true });
await cp(webDist, bundledWeb, { recursive: true });

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    count += entry.isDirectory()
      ? await countFiles(resolve(directory, entry.name))
      : 1;
  }
  return count;
}

const [{ size }, webFileCount] = await Promise.all([
  stat(bundledServer),
  countFiles(bundledWeb),
]);

console.log(`[desktop:bundle] Server bundle: ${(size / 1024 / 1024).toFixed(2)} MiB`);
console.log(`[desktop:bundle] SPA files copied: ${webFileCount}`);
console.log('[desktop:bundle] Layout: desktop/resources/{server/dist/{index.js,package.json,runtime-catalog.json},web/dist/}');
