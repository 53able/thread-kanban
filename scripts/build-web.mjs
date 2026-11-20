// ui/ のフロントエンドを dist/web-static/ にまとめる（esbuild の API と静的ファイルのコピー）。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'web-static');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'ui', 'main.tsx')],
  outfile: join(outDir, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const file of ['index.html', 'app.css']) copyFileSync(join(root, 'ui', file), join(outDir, file));
