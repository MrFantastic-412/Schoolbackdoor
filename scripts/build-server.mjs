import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const ENTRY_FILE = path.join(ROOT_DIR, 'server', 'app.ts');
const OUT_DIR = path.join(ROOT_DIR, 'api', '_server');
const OUT_FILE = path.join(OUT_DIR, 'app.mjs');
const SCHEMA_SRC = path.join(ROOT_DIR, 'server', 'db', 'schema.sql');
const SCHEMA_DEST = path.join(OUT_DIR, 'schema.sql');

const ifExistsOnly = process.argv.includes('--if-exists');

if (!fs.existsSync(ENTRY_FILE)) {
  if (ifExistsOnly) {
    process.exit(0);
  }
  console.error(`[build-server] Missing server entry point: ${ENTRY_FILE}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

await esbuild.build({
  entryPoints: [ENTRY_FILE],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

if (fs.existsSync(SCHEMA_SRC)) {
  fs.copyFileSync(SCHEMA_SRC, SCHEMA_DEST);
}

console.log(`[build-server] Built Node 22 ESM serverless bundle -> ${path.relative(ROOT_DIR, OUT_FILE)}`);
