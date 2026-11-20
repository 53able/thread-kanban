// 競合テスト用の子プロセス。ビルド済みストアで DB を開き、親の合図で一斉に移動を試みる。
// argv: dbPath boardId threadId
import { createInterface } from 'node:readline';
import { KanbanStore } from '../../dist/store/sqlite.js';

const [dbPath, boardId, threadId] = process.argv.slice(2);
const store = KanbanStore.open({ path: dbPath, boardId });
process.stdout.write('ready\n');

const rl = createInterface({ input: process.stdin });
rl.once('line', () => {
  const result = store.moveCard(threadId, { to: 'doing' });
  store.close();
  process.stdout.write(`${JSON.stringify({ ok: result.ok, code: result.ok ? null : result.error.code })}\n`);
  rl.close();
  process.stdin.destroy();
});
