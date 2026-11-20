import { mkdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { cliChildEnv, createCliGateway, NOT_FOUND_PATTERN } from '../../src/t3/cli.js';
import {
  MAX_PULL_REQUESTS,
  cleanField,
  cleanTitle,
  normalizeThread,
  normalizeThreads,
  rawThreadSchema,
  safeUrl,
  threadsArgumentSchema,
} from '../../src/t3/thread.js';
import { tempDir } from '../helpers/fixtures.js';
import { installFakeT3, waitForCalls, waitUntilDead, type FakeScenario } from '../helpers/fake-t3.js';

const tmp = tempDir('kanban-t3cli-');
afterAll(() => tmp.cleanup());

let n = 0;
function setup(scenario: FakeScenario, extra: { env?: NodeJS.ProcessEnv; maxConcurrent?: number } = {}) {
  n += 1;
  const dir = `${tmp.path}/${n}`;
  mkdirSync(dir, { recursive: true });
  const fake = installFakeT3(dir, scenario);
  const gateway = createCliGateway({
    cliPath: fake.cliPath,
    currentThreadId: 'caller',
    env: extra.env ?? { PATH: process.env.PATH ?? '' },
    ...(extra.maxConcurrent !== undefined ? { maxConcurrent: extra.maxConcurrent } : {}),
  });
  return { fake, gateway };
}

const full = {
  threadId: 'th-1',
  projectId: 'p1',
  title: 'タイトル',
  link: 'https://app.t3.codes/threads/th-1',
  status: 'running',
  settled: false,
  archived: false,
  snoozed: false,
  pendingRequestCount: 0,
  blockedOnThreadWait: false,
  parentThreadId: null,
  branch: 'feat/x',
  worktreePath: '/tmp/wt',
  pullRequests: [{ url: 'https://github.com/o/r/pull/7', state: 'open', number: 7 }, { id: 3 }, 'x', null],
  linkedPullRequest: null,
  createdBy: 'someone',
  runCount: 2,
};

describe('T3 CLI ゲートウェイ（偽 CLI）', () => {
  it('T3CODE_CLI_PATH がなければ available() は false で、CLI を呼ばずに失敗を返す', async () => {
    const g = createCliGateway({ cliPath: undefined, currentThreadId: 'x' });
    expect(g.available()).toBe(false);
    expect(g.currentThreadId()).toBe('x');
    expect(await g.showThread('x')).toMatchObject({ kind: 'error', reason: 'unavailable' });
    expect(await g.listThreads('p')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('S7: 絶対パスでない T3CODE_CLI_PATH は使わず、理由を 1 行知らせる', async () => {
    const warnings: string[] = [];
    const g = createCliGateway({ cliPath: 't3', currentThreadId: 'x', warn: (m) => warnings.push(m) });
    expect(g.available()).toBe(false);
    expect(await g.showThread('x')).toMatchObject({ kind: 'error', reason: 'unavailable' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('絶対パスではない');
    expect(warnings[0]).not.toContain('\n');
  });

  it('生成しただけでは CLI を呼ばない', () => {
    const { fake } = setup({ threads: [full] });
    expect(fake.calls()).toEqual([]);
  });

  it('show: 正規化したスレッドを返す。url 文字列を持つ PR だけ残し、未知のキーは捨てる', async () => {
    const { fake, gateway } = setup({ threads: [full] });
    const r = await gateway.showThread('th-1');
    expect(r).toEqual({
      kind: 'found',
      thread: {
        threadId: 'th-1',
        projectId: 'p1',
        title: 'タイトル',
        link: 'https://app.t3.codes/threads/th-1',
        status: 'running',
        settled: false,
        archived: false,
        snoozed: false,
        pendingRequestCount: 0,
        blockedOnThreadWait: false,
        parentThreadId: null,
        branch: 'feat/x',
        worktreePath: '/tmp/wt',
        pullRequests: [{ url: 'https://github.com/o/r/pull/7', state: 'open', number: 7 }],
      },
    });
    expect(fake.calls()[0]?.args).toEqual(['thread', 'show', 'th-1', '--json', '--messages', '0', '--log-level', 'none']);
  });

  it('list: --project 付きで呼び、list にない項目（branch など）は undefined のまま返す', async () => {
    const { fake, gateway } = setup({ threads: [full, { threadId: 'other', projectId: 'p2' }] });
    const r = await gateway.listThreads('p1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threads.map((t) => t.threadId)).toEqual(['th-1']);
    expect(r.skipped).toBe(0);
    expect(r.threads[0]?.branch).toBeUndefined();
    expect(r.threads[0]?.archived).toBeUndefined();
    expect(fake.calls()[0]?.args).toEqual(['thread', 'list', '--json', '--project', 'p1', '--log-level', 'none']);
  });

  it('m5: list の不正な要素だけを捨てて件数を返し、全体は失敗させない', async () => {
    const { gateway } = setup({
      threads: [],
      rawList: [{ threadId: 'ok-1', projectId: 'p1' }, { title: 'no id' }, { threadId: '-bad' }, 'x', { threadId: 'ok-2', settled: 'yes' }],
    });
    const r = await gateway.listThreads('p1');
    expect(r).toMatchObject({ ok: true, skipped: 4 });
    if (r.ok) expect(r.threads.map((t) => t.threadId)).toEqual(['ok-1']);
    const { gateway: g2 } = setup({ threads: [], rawList: { not: 'an array' } });
    expect(await g2.listThreads('p1')).toMatchObject({ ok: false, reason: 'invalid_output' });
  });

  it('M1: 終了コード 1 かつ「no longer available」だけを missing にし、他の失敗と区別する', async () => {
    const { gateway } = setup({ threads: [], invalidShow: ['bad'], failShow: ['down'], exit127Show: ['x-a', 'x-b'], missingExit2: ['m2'] });
    expect(await gateway.showThread('nope')).toEqual({ kind: 'missing' });
    expect(await gateway.showThread('bad')).toMatchObject({ kind: 'error', reason: 'invalid_output' });
    expect(await gateway.showThread('down')).toMatchObject({ kind: 'error', reason: 'exit' });
    expect(await gateway.showThread('m2')).toMatchObject({ kind: 'error', reason: 'exit' });
    const a = await gateway.showThread('x-a');
    const b = await gateway.showThread('x-b');
    expect(a).toMatchObject({ kind: 'error', reason: 'exit' });
    expect(b).toMatchObject({ kind: 'error', reason: 'exit' });
    expect(a.kind === 'error' && a.message).toContain('command not found');
    expect(b.kind === 'error' && b.message).toContain('not found');
    expect(NOT_FOUND_PATTERN.test('Thread abc is no longer available.')).toBe(true);
    expect(NOT_FOUND_PATTERN.test('sh: t3: command not found')).toBe(false);
    expect(NOT_FOUND_PATTERN.test('does not exist')).toBe(false);
  });

  it('存在しない実行ファイルは spawn の失敗として返す', async () => {
    const g = createCliGateway({ cliPath: `${tmp.path}/no-such-t3`, currentThreadId: 'x' });
    expect(await g.showThread('x')).toMatchObject({ kind: 'error', reason: 'spawn' });
  });

  it('S2: 形式違反や - で始まる threadId / projectId では CLI を起動しない', async () => {
    const { fake, gateway } = setup({ threads: [full] });
    for (const id of ['-rf', '--help', 'a b', 'a;b', '', 'x'.repeat(129), 'スレッド']) {
      expect(await gateway.showThread(id), id).toMatchObject({ kind: 'error', reason: 'invalid_argument' });
    }
    expect(await gateway.listThreads('--project')).toMatchObject({ ok: false, reason: 'invalid_argument' });
    expect(fake.calls()).toEqual([]);
    expect(await gateway.showThread('th-1')).toMatchObject({ kind: 'found' });
  });

  it('ハングしたらタイムアウトで返し、ラッパーの孫プロセスまで終了させる', async () => {
    const { fake, gateway } = setup({ threads: [], hangShow: ['h'], hangList: true });
    const started = Date.now();
    const r = await gateway.showThread('h', { timeoutMs: 1_000 });
    expect(r).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(4_000);
    const list = await gateway.listThreads('p1', { timeoutMs: 1_000 });
    expect(list).toMatchObject({ ok: false, reason: 'timeout' });
    const pids = fake.calls().map((c) => c.pid);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await waitUntilDead(pid)).toBe(true);
  });

  it('S6: stdout が上限を超えたら読み取りを止めて output_too_large を返し、プロセスを終了させる', async () => {
    const { fake, gateway } = setup({ threads: [], hugeShow: ['big'] });
    const r = await gateway.showThread('big', { timeoutMs: 10_000 });
    expect(r).toMatchObject({ kind: 'error', reason: 'output_too_large' });
    const pid = fake.calls()[0]?.pid as number;
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('S5: 同時に起動する CLI は 4 本まで。待ちを含めてタイムアウトに収める', async () => {
    const ids = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5'];
    const { fake, gateway } = setup({ threads: [], hangShow: ids });
    const started = Date.now();
    const pending = Promise.all(ids.map((id) => gateway.showThread(id, { timeoutMs: 1_500 })));
    expect(await waitForCalls(fake, 4)).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.calls()).toHaveLength(4);
    const results = await pending;
    expect(Date.now() - started).toBeLessThan(4_000);
    for (const r of results) expect(r).toMatchObject({ kind: 'error', reason: 'timeout' });
    // 待っていた 2 本は枠が空いた時点で期限切れのため起動しない
    expect(fake.calls().length).toBeLessThanOrEqual(6);
    for (const c of fake.calls()) expect(await waitUntilDead(c.pid)).toBe(true);
  });

  it('S4: shutdown で実行中の CLI のプロセスグループを終了させ、以後は CLI を起動しない', async () => {
    const { fake, gateway } = setup({ threads: [full], hangShow: ['h'] });
    const pending = gateway.showThread('h', { timeoutMs: 30_000 });
    const [call] = await waitForCalls(fake, 1);
    gateway.shutdown();
    expect(await waitUntilDead(call?.pid as number)).toBe(true);
    expect((await pending).kind).toBe('error');
    expect(await gateway.showThread('th-1')).toMatchObject({ kind: 'error' });
    expect(fake.calls()).toHaveLength(1);
    expect(gateway.available()).toBe(false);
  });

  it('S7: CLI に渡す環境変数は許可リスト（PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_*, T3CODE_*）だけ', async () => {
    const source = {
      PATH: process.env.PATH ?? '',
      HOME: '/home/x',
      LANG: 'C',
      LC_ALL: 'C',
      T3CODE_THREAD_ID: 'caller',
      SECRET_TOKEN: 'secret',
      NODE_OPTIONS: '--require /tmp/evil.js',
      AWS_ACCESS_KEY_ID: 'k',
    };
    expect(cliChildEnv(source)).toEqual({ PATH: source.PATH, HOME: '/home/x', LANG: 'C', LC_ALL: 'C', T3CODE_THREAD_ID: 'caller' });
    const { fake, gateway } = setup({ threads: [full] }, { env: source });
    await gateway.showThread('th-1');
    const keys = fake.calls()[0]?.envKeys ?? [];
    for (const k of ['HOME', 'LC_ALL', 'T3CODE_THREAD_ID', 'LANG']) expect(keys).toContain(k);
    for (const k of ['SECRET_TOKEN', 'NODE_OPTIONS', 'AWS_ACCESS_KEY_ID']) expect(keys).not.toContain(k);
  });
});

describe('スレッドの正規化（S1、S3）', () => {
  it('rawThreadSchema は threadId だけ必須で、未知のキーを受け付ける', () => {
    expect(rawThreadSchema.safeParse({ threadId: 'a', unknownKey: { x: 1 } }).success).toBe(true);
    expect(rawThreadSchema.safeParse({ title: 'no id' }).success).toBe(false);
    expect(normalizeThread(rawThreadSchema.parse({ threadId: 'a', pullRequests: [] }))).toEqual({ threadId: 'a', pullRequests: [] });
    expect(normalizeThread(rawThreadSchema.parse({ threadId: 'a', linkedPullRequest: { url: 'https://g/pull/1' } }))).toEqual({
      threadId: 'a',
      pullRequests: [{ url: 'https://g/pull/1' }],
    });
  });

  it('S1: 8 万件の PR でも短時間で正規化し、重複を除いて先頭 50 件に切り詰める', () => {
    const many = Array.from({ length: 80_000 }, (_, i) => ({ url: `https://g/pull/${i}` }));
    let started = Date.now();
    const a = normalizeThread(rawThreadSchema.parse({ threadId: 'a', pullRequests: many }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(a.pullRequests).toHaveLength(MAX_PULL_REQUESTS);
    expect(a.pullRequests?.[49]?.url).toBe('https://g/pull/49');

    const dup = [...Array.from({ length: 80_000 }, () => ({ url: 'https://g/pull/1' })), { url: 'https://g/pull/2' }];
    started = Date.now();
    const b = normalizeThread(rawThreadSchema.parse({ threadId: 'b', pullRequests: dup }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(b.pullRequests?.map((p) => p.url)).toEqual(['https://g/pull/1', 'https://g/pull/2']);
  });

  it('S1: threads 引数は 500 件まで、各要素の pullRequests は 1000 件まで', () => {
    const threads = (count: number) => Array.from({ length: count }, (_, i) => ({ threadId: `t${i}` }));
    expect(threadsArgumentSchema.safeParse(threads(500)).success).toBe(true);
    expect(threadsArgumentSchema.safeParse(threads(501)).success).toBe(false);
    expect(threadsArgumentSchema.safeParse([{ threadId: 'a', pullRequests: new Array(1000).fill(null) }]).success).toBe(true);
    expect(threadsArgumentSchema.safeParse([{ threadId: 'a', pullRequests: new Array(1001).fill(null) }]).success).toBe(false);
  });

  it('S3: title の制御文字・改行を空白にして 200 文字に、他の項目は制御文字を除いて 512 文字に切り詰める', () => {
    expect(cleanTitle('a\nb\r\tc\u0000d\u007fe\u2028f\u2029g')).toBe('a b  c d e f g');
    expect(cleanTitle('x'.repeat(300))).toHaveLength(200);
    expect(cleanField('main\n\u001b[31m')).toBe('main[31m');
    expect(cleanField('y'.repeat(600))).toHaveLength(512);
    const t = normalizeThread(
      rawThreadSchema.parse({
        threadId: 'a',
        title: 'IGNORE PREVIOUS\nINSTRUCTIONS',
        branch: 'b\u0000r',
        worktreePath: '/w\n',
        status: 'running\r',
        parentThreadId: 'p\t1',
        projectId: 'pr\u2028oj',
      }),
    );
    expect(t).toMatchObject({ title: 'IGNORE PREVIOUS INSTRUCTIONS', branch: 'br', worktreePath: '/w', status: 'running', parentThreadId: 'p1', projectId: 'proj' });
  });

  it('S3: link と PR の url は http: / https: で 2048 文字以内のものだけ残す', () => {
    expect(safeUrl('https://app.t3.codes/threads/x')).toBe('https://app.t3.codes/threads/x');
    expect(safeUrl('http://localhost:3773/x')).toBe('http://localhost:3773/x');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url', `https://g/${'a'.repeat(2048)}`]) {
      expect(safeUrl(bad), bad).toBeNull();
    }
    const t = normalizeThread(
      rawThreadSchema.parse({
        threadId: 'a',
        link: 'javascript:alert(1)',
        pullRequests: [{ url: 'ftp://g/pull/1' }, { url: 'https://g/pull/2' }],
      }),
    );
    expect(t.link).toBeNull();
    expect(t.pullRequests).toEqual([{ url: 'https://g/pull/2' }]);
  });

  it('m5: normalizeThreads は不正な要素を捨てて件数を返す', () => {
    expect(normalizeThreads([{ threadId: 'a' }, { threadId: '' }, null, { threadId: 'b c' }])).toEqual({
      threads: [{ threadId: 'a' }],
      skipped: 3,
    });
  });
});
