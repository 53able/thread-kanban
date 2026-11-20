import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** e2e / 競合テストは dist/ を子プロセスで起動するため、テスト開始前に一度ビルドする。 */
export default function setup(): void {
  const root = join(import.meta.dirname, '..');
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  });
}
