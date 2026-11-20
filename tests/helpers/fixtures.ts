import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOARD_COLUMNS,
  DEFAULT_WIP_LIMITS,
  type BoardConfig,
  type Card,
  type Clock,
} from '../../src/domain/types.js';

export const ROOT = join(import.meta.dirname, '..', '..');
export const DIST_INDEX = join(ROOT, 'dist', 'index.js');

export const T0 = Date.parse('2026-01-05T00:00:00.000Z'); // 月曜
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function makeBoard(overrides: Partial<Record<(typeof BOARD_COLUMNS)[number], { wipLimit?: number | null; entryCriteria?: string[] }>> = {}): BoardConfig {
  return {
    id: 'test-board',
    staleDays: 3,
    columns: BOARD_COLUMNS.map((name, position) => ({
      name,
      position,
      wipLimit: overrides[name]?.wipLimit !== undefined ? (overrides[name]?.wipLimit ?? null) : DEFAULT_WIP_LIMITS[name],
      entryCriteria: overrides[name]?.entryCriteria ?? [],
    })),
  };
}

let nextId = 1;
export function makeCard(overrides: Partial<Card> = {}): Card {
  const id = overrides.id ?? nextId++;
  return {
    id,
    boardId: 'test-board',
    threadId: `thread-${id}`,
    title: `card ${id}`,
    description: null,
    type: 'feature',
    serviceClass: 'regular',
    dueDate: null,
    size: null,
    externalRefs: [],
    t3: null,
    column: 'inbox',
    columnEnteredAt: T0,
    blocked: null,
    createdAt: T0,
    updatedAt: T0,
    lastEventAt: T0,
    ...overrides,
  };
}

/** 手動で進める時計。 */
export function manualClock(start = T0): Clock & { set(ms: number): void; advance(ms: number): void } {
  let now = start;
  const clock = (() => now) as Clock & { set(ms: number): void; advance(ms: number): void };
  clock.set = (ms) => {
    now = ms;
  };
  clock.advance = (ms) => {
    now += ms;
  };
  return clock;
}

export function tempDir(prefix = 'kanban-test-'): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
