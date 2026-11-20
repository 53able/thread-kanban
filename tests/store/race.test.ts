import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KanbanStore } from '../../src/store/sqlite.js';
import { ROOT, tempDir } from '../helpers/fixtures.js';

const CHILD = join(ROOT, 'tests', 'fixtures', 'race-child.mjs');
const ITERATIONS = 20;

interface Child {
  proc: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  result: Promise<{ ok: boolean; code: string | null }>;
}

function startChild(dbPath: string, boardId: string, threadId: string): Child {
  const proc = spawn(process.execPath, [CHILD, dbPath, boardId, threadId], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  let onReady: () => void = () => {};
  let onResult: (v: { ok: boolean; code: string | null }) => void = () => {};
  let onFail: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  const result = new Promise<{ ok: boolean; code: string | null }>((resolve, reject) => {
    onResult = resolve;
    onFail = reject;
  });
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  proc.stdout.on('data', (d: Buffer) => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === 'ready') onReady();
      else if (line.trim() !== '') onResult(JSON.parse(line) as { ok: boolean; code: string | null });
    }
  });
  proc.on('exit', (code) => {
    if (code !== 0) onFail(new Error(`child exited with ${code}: ${stderr}`));
  });
  return { proc, ready, result };
}

describe('プロセス間の原子性', () => {
  const tmp = tempDir('kanban-race-');
  afterAll(() => tmp.cleanup());

  it(`2 つの別プロセスが同時に doing の最後の 1 枠へ移動を試みると、${ITERATIONS} 回とも成功はちょうど 1 件`, async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const dbPath = join(tmp.path, `race-${i}.db`);
      const boardId = 'race';
      const setup = KanbanStore.open({ path: dbPath, boardId });
      for (const t of ['d1', 'd2', 'a', 'b']) {
        setup.addCard({ threadId: t, title: t });
        setup.moveCard(t, { to: 'ready' });
      }
      setup.moveCard('d1', { to: 'doing' });
      setup.moveCard('d2', { to: 'doing' });
      expect(setup.getBoardConfig().columns.find((c) => c.name === 'doing')?.wipLimit).toBe(3);
      setup.close();

      const children = [startChild(dbPath, boardId, 'a'), startChild(dbPath, boardId, 'b')];
      await Promise.all(children.map((c) => c.ready));
      for (const c of children) c.proc.stdin.end('go\n');
      const exits = children.map((c) => new Promise<number | null>((resolve) => c.proc.once('exit', resolve)));
      const results = await Promise.all(children.map((c) => c.result));

      expect(await Promise.all(exits)).toEqual([0, 0]);
      const successes = results.filter((r) => r.ok).length;
      const failures = results.filter((r) => !r.ok);
      outcomes.push(results.map((r) => (r.ok ? 'ok' : r.code)).join('/'));
      expect(successes, `iteration ${i}: ${JSON.stringify(results)}`).toBe(1);
      expect(failures.map((f) => f.code)).toEqual(['WIP_LIMIT_EXCEEDED']);

      const check = KanbanStore.open({ path: dbPath, boardId });
      expect(check.snapshot().cards.filter((c) => c.column === 'doing')).toHaveLength(3);
      check.close();
    }
    expect(outcomes).toHaveLength(ITERATIONS);
  });
});
