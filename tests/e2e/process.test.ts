import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DIST_INDEX, ROOT, tempDir } from '../helpers/fixtures.js';
import { childEnv, startServer, structured } from '../helpers/mcp.js';

const tmp = tempDir('kanban-proc-');
afterAll(() => tmp.cleanup());

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

/** サーバーを起動し、input を書いて stdin を閉じ、終了までの stdout を生バイトで集める。 */
function runRaw(command: string, args: string[], env: Record<string, string>, input: string, cwd = ROOT): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ stdout: Buffer.concat(out), stderr: err, code }));
    const lines = input.split('\n').filter((l) => l !== '');
    // initialize の応答を受け取ってから stdin を閉じる（処理中の要求は stdin 終了で破棄されるため）
    if (lines.length === 0) {
      proc.stdin.end();
      return;
    }
    let pending = lines.filter((l) => 'id' in (JSON.parse(l) as object)).length;
    proc.stdout.on('data', (d: Buffer) => {
      pending -= d.toString().split('\n').filter((l) => l.trim() !== '').length;
      if (pending <= 0) proc.stdin.end();
    });
    proc.stdin.write(`${lines.join('\n')}\n`);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

function env(name: string): Record<string, string> {
  const home = join(tmp.path, `home-${name}`);
  mkdirSync(home, { recursive: true });
  return { HOME: home, KANBAN_DB_PATH: join(tmp.path, `${name}.db`) };
}

describe('stdout は MCP プロトコル専用', () => {
  it('入力なしで起動・終了したとき、node:sqlite の読み込みと DB 作成を経ても stdout に 1 バイトも出ない', async () => {
    const e = env('silent');
    const r = await runRaw(process.execPath, [DIST_INDEX], e, '');
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(existsSync(e.KANBAN_DB_PATH as string)).toBe(true); // DB を実際に開いている
    expect(r.stderr).toContain('[thread-kanban] board=');
  });

  it('警告を出しやすいフラグ付きで起動しても stdout に出るのは JSON-RPC の行だけ', async () => {
    const e = { ...env('warn'), NODE_OPTIONS: '--trace-warnings --pending-deprecation' };
    const r = await runRaw(process.execPath, [DIST_INDEX], e, INITIALIZE);
    const lines = r.stdout.toString('utf8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(1);
    for (const line of lines) {
      const msg = JSON.parse(line) as { jsonrpc: string; id: number };
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id).toBe(1);
    }
  });

  it('サーバー内で console.log / console.warn / process.emitWarning されても stdout に出ない', async () => {
    const e = env('console');
    const script = [
      `process.argv[1] = ${JSON.stringify(DIST_INDEX)};`,
      `await import(${JSON.stringify(`file://${DIST_INDEX}`)});`,
      `console.log('noise-log'); console.warn('noise-warn'); console.info('noise-info');`,
      `process.emitWarning('noise-warning', 'ExperimentalWarning');`,
    ].join('\n');
    const r = await runRaw(process.execPath, ['--input-type=module', '-e', script], e, '');
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toContain('noise-log');
    expect(r.stderr).toContain('noise-warning');
  });
});

describe('.mcp.json', () => {
  it('ビルド済みエントリポイントを指し、そのコマンドで実際にサーバーが起動して initialize に応答する', async () => {
    const config = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const kanban = config.mcpServers['thread-kanban'];
    expect(kanban).toBeDefined();
    if (kanban === undefined) return;
    expect(kanban.command).toBe('node');
    expect(kanban.args).toEqual(['dist/index.js']);
    expect(existsSync(join(ROOT, kanban.args[0] as string))).toBe(true);

    const r = await runRaw(kanban.command, kanban.args, env('mcpjson'), INITIALIZE, ROOT);
    const response = JSON.parse(r.stdout.toString('utf8').trim()) as {
      id: number;
      result: { serverInfo: { name: string }; capabilities: { tools?: unknown } };
    };
    expect(response.id).toBe(1);
    expect(response.result.serverInfo.name).toBe('thread-kanban');
    expect(response.result.capabilities.tools).toBeDefined();
  });
});

describe('worktree 間のボード共有', () => {
  it('別 worktree から起動したサーバーが同じボードを返す（KANBAN_DB_PATH なし、HOME は一時ディレクトリ）', async () => {
    const repo = join(tmp.path, 'repo');
    const wt = join(tmp.path, 'wt');
    const home = join(tmp.path, 'home-wt');
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env: gitEnv });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt', wt], { cwd: repo, env: gitEnv });

    const main = await startServer({ HOME: home }, repo);
    const other = await startServer({ HOME: home }, wt);
    try {
      await main.call('kanban_card_add', { threadId: 'from-main', title: 'main' });
      await other.call('kanban_card_add', { threadId: 'from-wt', title: 'worktree' });
      const boardMain = structured(await main.call('kanban_board_get')).board;
      const boardWt = structured(await other.call('kanban_board_get')).board;
      expect(boardWt.boardId).toBe(boardMain.boardId);
      const ids = (b: { columns: { cards: { threadId: string }[] }[] }) =>
        b.columns.flatMap((c) => c.cards.map((x) => x.threadId)).sort();
      expect(ids(boardMain)).toEqual(['from-main', 'from-wt']);
      expect(ids(boardWt)).toEqual(['from-main', 'from-wt']);
      expect(readdirSync(join(home, '.t3-kanban')).filter((f) => f.endsWith('.db'))).toEqual([`${boardMain.boardId}.db`]);
    } finally {
      await main.close();
      await other.close();
    }
  });
});
