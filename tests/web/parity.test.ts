// 受け入れ基準 5・6・12: MCP（インメモリのトランスポート）と UI の API が同じ結果になること。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KanbanEvent, T3Tracking } from '../../src/domain/types.js';
import { KanbanReader, KanbanStore } from '../../src/store/sqlite.js';
import { boardKey, normalizeDbPath } from '../../src/web/discovery.js';
import type { UiServer } from '../../src/web/server.js';
import { manualClock, T0, tempDir } from '../helpers/fixtures.js';
import { structured, text } from '../helpers/mcp.js';
import { startMcp, startUi, withoutKeys, type McpHarness, type UiClient } from './helpers.js';

const BOARD_ID = 'parity';
const clock = manualClock(T0 + 3_600_000);
const tmp = tempDir('kanban-parity-');
const home = join(tmp.path, 'home');
const mcpDir = join(tmp.path, 'mcp');
let server: UiServer;
let client: UiClient;
let counter = 0;

beforeAll(async () => {
  mkdirSync(join(home, '.t3-kanban'), { recursive: true });
  mkdirSync(mcpDir, { recursive: true });
  const r = await startUi({ homeDir: home, clock });
  server = r.server;
  client = r.client;
});

afterAll(async () => {
  await server.close();
  tmp.cleanup();
});

const tracking = (threadId: string): T3Tracking => ({
  link: `t3://thread/${threadId}`,
  projectId: 'p1',
  parentThreadId: null,
  branch: `feat/${threadId}`,
  worktreePath: null,
  pullRequests: [],
  syncedAt: T0,
});

interface Variant {
  /** doing にも入場条件を付ける（入場条件と WIP 満杯の両方） */
  doingCriteria?: boolean;
}

/**
 * 共通の初期状態。doing と review の WIP は 1、ready に入場条件。
 * - d: done（T3 の追跡参照あり） / r: review（追跡参照あり） / a: doing
 * - b: ready / k: ready（ブロック中） / e: ready（expedite） / c: inbox
 */
function seed(path: string, variant: Variant): void {
  const store = KanbanStore.open({ path, boardId: BOARD_ID, clock });
  try {
    const ok = <T>(r: { ok: boolean } & T): void => {
      if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r)}`);
    };
    ok(store.configure({ columns: [{ column: 'doing', wipLimit: 1 }, { column: 'review', wipLimit: 1 }, { column: 'ready', entryCriteria: ['仕様が決まっている'] }] }));
    const walk = (threadId: string, to: readonly ('ready' | 'doing' | 'review' | 'done')[]): void => {
      for (const col of to) ok(store.moveCard(threadId, { to: col, criteriaConfirmed: col === 'ready' }));
    };
    ok(store.addCard({ threadId: 'd', title: 'done card', t3: tracking('d') }));
    walk('d', ['ready', 'doing', 'review', 'done']);
    ok(store.addCard({ threadId: 'r', title: 'review card', t3: tracking('r') }));
    walk('r', ['ready', 'doing', 'review']);
    ok(store.addCard({ threadId: 'a', title: 'doing card' }));
    walk('a', ['ready', 'doing']);
    ok(store.addCard({ threadId: 'b', title: 'ready card' }));
    walk('b', ['ready']);
    ok(store.addCard({ threadId: 'k', title: 'blocked card' }));
    walk('k', ['ready']);
    ok(store.blockCard('k', '外部待ち'));
    ok(store.addCard({ threadId: 'e', title: 'expedite card', serviceClass: 'expedite' }));
    walk('e', ['ready']);
    ok(store.addCard({ threadId: 'c', title: 'inbox card' }));
    if (variant.doingCriteria === true) {
      ok(store.configure({ columns: [{ column: 'doing', entryCriteria: ['レビュー担当が決まっている'] }] }));
    }
  } finally {
    store.close();
  }
}

interface Pair {
  mcp: McpHarness;
  key: string;
  uiPath: string;
}

async function pair(variant: Variant = {}): Promise<Pair> {
  counter += 1;
  const uiPath = join(home, '.t3-kanban', `case-${counter}.db`);
  const mcpPath = join(mcpDir, `case-${counter}.db`);
  seed(uiPath, variant);
  seed(mcpPath, variant);
  const mcp = await startMcp(mcpPath, BOARD_ID, clock);
  return { mcp, key: boardKey(normalizeDbPath(uiPath), BOARD_ID), uiPath };
}

function uiEvents(path: string): KanbanEvent[] {
  const reader = KanbanReader.open({ path, boardId: BOARD_ID });
  try {
    return reader.listEventsSince(0, 10_000).events;
  } finally {
    reader.close();
  }
}

function comparable(events: readonly KanbanEvent[]): unknown[] {
  return events.map((e) => ({ type: e.type, fromColumn: e.fromColumn, toColumn: e.toColumn, data: withoutKeys(e.data, ['actor']) }));
}

type Tool = 'kanban_card_move' | 'kanban_card_block' | 'kanban_card_unblock';
const ACTION: Record<Tool, string> = { kanban_card_move: 'move', kanban_card_block: 'block', kanban_card_unblock: 'unblock' };

/** 同じ操作を MCP と UI に送り、応答（ok / notes を除く）とイベント列（actor を除く）を比べる。 */
async function compare(tool: Tool, threadId: string, input: Record<string, unknown>, variant: Variant = {}) {
  const p = await pair(variant);
  try {
    const before = uiEvents(p.uiPath).length;
    const m = await p.mcp.call(tool, { threadId, ...input });
    const u = await client.post(client.card(p.key, threadId, ACTION[tool]), input);
    const sc = structured(m);
    expect(u.json.ok).toBe(sc.ok);
    // lastEventId は UI 専用（MCP の structuredContent にはない）。成功時は数値で付く
    if (u.json.ok === true) expect(typeof u.json.lastEventId).toBe('number');
    expect(sc).not.toHaveProperty('lastEventId');
    expect(withoutKeys(u.json, ['ok', 'notes', 'lastEventId'])).toEqual(withoutKeys(sc, ['ok']));
    const uiAll = uiEvents(p.uiPath);
    expect(comparable(uiAll)).toEqual(comparable(p.mcp.store.listEvents()));
    // UI の操作で増えたイベントはすべて actor: 'ui'
    for (const e of uiAll.slice(before)) expect(e.data.actor).toBe('ui');
    return { mcp: m, mcpStructured: sc, ui: u.json, uiStatus: u.status };
  } finally {
    await p.mcp.close();
  }
}

describe('MCP と UI が同じ結果になる（受け入れ基準 5）', () => {
  it('WIP 超過', async () => {
    const r = await compare('kanban_card_move', 'b', { to: 'doing' });
    expect(r.ui.code).toBe('WIP_LIMIT_EXCEEDED');
    expect(r.uiStatus).toBe(409);
  });

  it('強行（force + reason）。notes は MCP の本文と UI の JSON の両方に入る', async () => {
    const r = await compare('kanban_card_move', 'b', { to: 'doing', force: true, reason: '障害対応' });
    expect(r.ui.ok).toBe(true);
    expect(r.ui.violation).toMatchObject({ column: 'doing', limit: 1, reason: '障害対応' });
    expect(r.ui.notes.length).toBeGreaterThan(0);
    for (const note of r.ui.notes) expect(text(r.mcp)).toContain(note);
  });

  it('CRITERIA_NOT_CONFIRMED と、入場条件を確認した移動', async () => {
    expect((await compare('kanban_card_move', 'c', { to: 'ready' })).ui.code).toBe('CRITERIA_NOT_CONFIRMED');
    const ok = await compare('kanban_card_move', 'c', { to: 'ready', criteriaConfirmed: true });
    expect(ok.ui).toMatchObject({ ok: true, from: 'inbox', to: 'ready', direction: 'forward' });
  });

  it('expedite は WIP 上限を超えて入る', async () => {
    const r = await compare('kanban_card_move', 'e', { to: 'doing' });
    expect(r.ui).toMatchObject({ ok: true, expediteOverLimit: true });
    for (const note of r.ui.notes) expect(text(r.mcp)).toContain(note);
  });

  it('ブロック中のカードの前進', async () => {
    expect((await compare('kanban_card_move', 'k', { to: 'doing' })).ui.code).toBe('BLOCKED');
  });

  it('後退時の入場条件と WIP', async () => {
    expect((await compare('kanban_card_move', 'a', { to: 'ready' })).ui.code).toBe('CRITERIA_NOT_CONFIRMED');
    expect((await compare('kanban_card_move', 'r', { to: 'doing' })).ui.code).toBe('WIP_LIMIT_EXCEEDED');
    expect((await compare('kanban_card_move', 'r', { to: 'ready', criteriaConfirmed: true })).ui.direction).toBe('backward');
  });

  it('force: true で reason が空・省略は両方とも FORCE_REASON_REQUIRED', async () => {
    expect((await compare('kanban_card_move', 'b', { to: 'doing', force: true, reason: '' })).ui.code).toBe('FORCE_REASON_REQUIRED');
    expect((await compare('kanban_card_move', 'b', { to: 'doing', force: true, reason: '   ' })).ui.code).toBe('FORCE_REASON_REQUIRED');
    expect((await compare('kanban_card_move', 'b', { to: 'doing', force: true })).ui.code).toBe('FORCE_REASON_REQUIRED');
  });

  it('不正な threadId は両方とも INVALID_ARGUMENT と details.threadId', async () => {
    const r = await compare('kanban_card_move', 'bad id!', { to: 'ready' });
    expect(r.ui).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', details: { threadId: 'bad id!' } });
    const padded = await compare('kanban_card_move', '  b  ', { to: 'inbox' });
    expect(padded.ui).toMatchObject({ ok: true, from: 'ready', to: 'inbox' });
  });

  it('存在しないカード、block / unblock とその失敗', async () => {
    expect((await compare('kanban_card_move', 'zzz', { to: 'ready' })).ui.code).toBe('CARD_NOT_FOUND');
    expect((await compare('kanban_card_block', 'b', { reason: 'API 待ち' })).ui.ok).toBe(true);
    expect((await compare('kanban_card_block', 'd', { reason: 'x' })).ui.code).toBe('CARD_NOT_ACTIVE');
    expect((await compare('kanban_card_block', 'k', { reason: 'x' })).ui.code).toBe('ALREADY_BLOCKED');
    expect((await compare('kanban_card_unblock', 'k', { resolution: '返答あり' })).ui).toMatchObject({ ok: true, blockedDays: expect.any(Number) });
    expect((await compare('kanban_card_unblock', 'k', {})).ui.ok).toBe(true);
    expect((await compare('kanban_card_unblock', 'b', {})).ui.code).toBe('NOT_BLOCKED');
  });

  it('block の空の reason: MCP は SDK の検証エラー、UI は 400 INVALID_ARGUMENT。どちらも DB を変えない', async () => {
    const p = await pair();
    try {
      const mcpBefore = p.mcp.store.listEvents().length;
      const uiBefore = uiEvents(p.uiPath).length;
      const m = await p.mcp.call('kanban_card_block', { threadId: 'b', reason: '' });
      expect(m.isError).toBe(true);
      expect((m.structuredContent as Record<string, unknown> | undefined)?.code).toBeUndefined();
      const u = await client.post(client.card(p.key, 'b', 'block'), { reason: '' });
      expect(u.status).toBe(400);
      expect(u.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      expect(p.mcp.store.listEvents()).toHaveLength(mcpBefore);
      expect(uiEvents(p.uiPath)).toHaveLength(uiBefore);
    } finally {
      await p.mcp.close();
    }
  });
});

describe('t3Action（受け入れ基準 12）', () => {
  it('done への移動の settle と、done からの差し戻しの unsettle が unavailableGateway の MCP と一致する', async () => {
    const settle = await compare('kanban_card_move', 'r', { to: 'done' });
    expect(settle.ui.t3Action).toMatchObject({ args: { action: 'settle', threadId: 'r' } });
    const unsettle = await compare('kanban_card_move', 'd', { to: 'ready', criteriaConfirmed: true });
    expect(unsettle.ui.t3Action).toMatchObject({ args: { action: 'unsettle', threadId: 'd' } });
    // 追跡参照のないカードは T3 のスレッドと判定できない（MCP も unavailableGateway では同じ）
    const plain = await compare('kanban_card_move', 'a', { to: 'review', force: true, reason: '並行レビュー' });
    expect(plain.ui.t3Action).toBeNull();
  });
});

describe('move-options と実際の移動の一致（受け入れ基準 6）', () => {
  const scenarios: { name: string; threadId: string; variant?: Variant }[] = [
    { name: '入場条件あり（inbox → ready）・飛び越し', threadId: 'c' },
    { name: 'WIP 満杯', threadId: 'b' },
    { name: '入場条件と WIP 満杯の両方', threadId: 'b', variant: { doingCriteria: true } },
    { name: 'ブロック中', threadId: 'k' },
    { name: '後退', threadId: 'r' },
    { name: 'done からの後退', threadId: 'd' },
    { name: 'expedite', threadId: 'e' },
    { name: 'expedite（doing に入場条件）', threadId: 'e', variant: { doingCriteria: true } },
  ];

  for (const sc of scenarios) {
    it(sc.name, async () => {
      const base = await pair(sc.variant);
      await base.mcp.close();
      const res = await client.get(client.card(base.key, sc.threadId, 'move-options'));
      expect(res.status).toBe(200);
      const options = res.json.options as any[];
      const board = (await client.get(`/api/boards/${base.key}`)).json.board;
      const current = board.columns.find((col: any) => col.cards.some((c: any) => c.threadId === sc.threadId)).column;
      // 現在の列と discarded は含めない
      expect(options.map((o) => o.column)).toEqual(['inbox', 'ready', 'doing', 'review', 'done'].filter((c) => c !== current));
      for (const option of options) {
        const p = await pair(sc.variant);
        await p.mcp.close();
        const u = await client.post(client.card(p.key, sc.threadId, 'move'), { to: option.column, criteriaConfirmed: true });
        const label = `${sc.threadId} → ${option.column}`;
        const config = board.columns.find((col: any) => col.column === option.column);
        expect(option.entryCriteria, label).toEqual(config.entryCriteria);
        expect(option.needsCriteria, label).toBe(config.entryCriteria.length > 0);
        if (!option.allowed) {
          expect(option.wip, label).toBeNull();
          expect(u.json.ok, label).toBe(false);
          expect(u.json.code, label).toBe(option.code);
        } else if (option.wip === 'exceeded') {
          expect(u.json.code, label).toBe('WIP_LIMIT_EXCEEDED');
          expect(option.occupants, label).toEqual(
            u.json.details.occupants.map((o: any) => ({ cardId: o.cardId, threadId: o.threadId, title: o.title })),
          );
        } else {
          expect(u.json.ok, label).toBe(true);
          expect(u.json.expediteOverLimit, label).toBe(option.wip === 'expediteOver');
        }
      }
    });
  }

  it('同じ列への移動は options に出ず、実際の移動は SAME_COLUMN', async () => {
    const p = await pair();
    await p.mcp.close();
    const options = (await client.get(client.card(p.key, 'b', 'move-options'))).json.options as any[];
    expect(options.some((o) => o.column === 'ready')).toBe(false);
    expect((await client.post(client.card(p.key, 'b', 'move'), { to: 'ready', criteriaConfirmed: true })).json.code).toBe('SAME_COLUMN');
  });
});
