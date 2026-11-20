import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures.js';

const SCRIPT = join(ROOT, 'tests', 'fixtures', 'fake-t3.mjs');

export interface FakeThread {
  threadId: string;
  projectId?: string;
  title?: string;
  link?: string;
  status?: string;
  settled?: boolean;
  archived?: boolean;
  snoozed?: boolean;
  pendingRequestCount?: number;
  blockedOnThreadWait?: boolean;
  parentThreadId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  pullRequests?: unknown[];
  linkedPullRequest?: unknown;
}

export interface FakeScenario {
  threads: FakeThread[];
  listIds?: string[];
  hangShow?: string[];
  hangList?: boolean;
  invalidShow?: string[];
  failShow?: string[];
  exit127Show?: string[];
  missingExit2?: string[];
  hugeShow?: string[];
  rawList?: unknown;
}

export interface FakeCall {
  pid: number;
  args: string[];
  /** 偽 CLI のプロセスが受け取った環境変数の名前 */
  envKeys: string[];
}

export interface FakeT3 {
  cliPath: string;
  /** サーバーに渡す環境変数（T3CODE_CLI_PATH）。シナリオのパスはラッパーが設定する */
  env: Record<string, string>;
  setScenario(scenario: FakeScenario): void;
  /** 偽 CLI が呼ばれた記録 */
  calls(): FakeCall[];
}

/**
 * dir に偽の t3 を置く。本物と同じく /bin/sh のラッパーから node を起動する（孫プロセスができる）。
 */
export function installFakeT3(dir: string, scenario: FakeScenario): FakeT3 {
  const cliPath = join(dir, 't3');
  const scenarioPath = join(dir, 'scenario.json');
  const logPath = join(dir, 'calls.log');
  // ゲートウェイは環境変数を許可リストで絞るため、シナリオのパスはラッパーの中で設定する
  writeFileSync(cliPath, `#!/bin/sh\nFAKE_T3_SCENARIO="${scenarioPath}" "${process.execPath}" "${SCRIPT}" "$@"\n`);
  chmodSync(cliPath, 0o755);
  const setScenario = (s: FakeScenario): void => writeFileSync(scenarioPath, JSON.stringify({ ...s, log: logPath }));
  setScenario(scenario);
  return {
    cliPath,
    env: { T3CODE_CLI_PATH: cliPath },
    setScenario,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l) as FakeCall)
        : [],
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pid が終了するまで 20ms 間隔で待つ（最大 timeoutMs）。終了したら true。 */
export async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

/** 偽 CLI の呼び出しが count 件記録されるまで待つ（最大 timeoutMs）。 */
export async function waitForCalls(fake: FakeT3, count: number, timeoutMs = 5_000): Promise<FakeCall[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calls = fake.calls();
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fake.calls();
}
