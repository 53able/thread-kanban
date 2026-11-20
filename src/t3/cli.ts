import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { isValidThreadId } from '../domain/types.js';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  unavailableGateway,
  type CallOptions,
  type ListResult,
  type ShowResult,
  type T3Failure,
  type T3Gateway,
} from './gateway.js';
import { normalizeThread, normalizeThreads, showOutputSchema, cleanTitle } from './thread.js';

export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
/** ゲートウェイ全体での CLI の同時実行数の上限（S5） */
export const MAX_CONCURRENT_CALLS = 4;

/**
 * `thread show` が「スレッドが存在しない」ときの stderr。
 * 実機（2026-11-20）で終了コード 1 と `Thread <id> is no longer available.` を確認した。
 * 終了コード 1 かつこの文言のときだけ存在しない扱いにする（M1）。
 */
export const NOT_FOUND_PATTERN = /is no longer available/i;
export const NOT_FOUND_EXIT_CODE = 1;

const INHERITED_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']);

/** CLI に渡す環境変数（S7）。許可リストの変数と LC_* / T3CODE_* だけを引き継ぐ。 */
export function cliChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (INHERITED_ENV.has(key) || key.startsWith('LC_') || key.startsWith('T3CODE_')) env[key] = value;
  }
  return env;
}

export interface CliGatewayOptions {
  /** T3CODE_CLI_PATH。未設定・絶対パスでなければ T3 は使えない（PATH 探索はしない） */
  cliPath: string | undefined;
  /** T3CODE_THREAD_ID */
  currentThreadId: string | undefined;
  timeoutMs?: number;
  /** 引き継ぎ元の環境変数（既定は process.env）。cliChildEnv で絞ってから渡す */
  env?: NodeJS.ProcessEnv;
  maxConcurrent?: number;
  /** 設定の問題を 1 行で知らせる先（既定は stderr） */
  warn?: (message: string) => void;
}

type RunResult = { kind: 'ok'; stdout: string } | { kind: 'exit'; code: number | null; stderr: string } | ({ kind: 'fail' } & T3Failure);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function exitFailure(r: { code: number | null; stderr: string }): T3Failure {
  return { reason: 'exit', message: `T3 CLI が終了コード ${r.code ?? 'null'} で失敗しました${r.stderr !== '' ? `: ${cleanTitle(r.stderr).slice(0, 500)}` : ''}` };
}

const timeoutFailure = (ms: number): T3Failure => ({ reason: 'timeout', message: `T3 CLI が ${ms}ms 以内に応答しませんでした` });

/** `T3CODE_CLI_PATH` の CLI を使うゲートウェイ。生成時には CLI を呼ばない。 */
export function createCliGateway(options: CliGatewayOptions): T3Gateway {
  const current = options.currentThreadId === undefined || options.currentThreadId === '' ? null : options.currentThreadId;
  const cliPath = options.cliPath;
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  if (cliPath === undefined || cliPath === '') return unavailableGateway(current);
  if (!isAbsolute(cliPath)) {
    const message = `T3CODE_CLI_PATH が絶対パスではないため T3 CLI を使いません: ${JSON.stringify(cliPath)}`;
    warn(`[thread-kanban] ${message}`);
    return unavailableGateway(current, message);
  }

  const defaultTimeout = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const env = cliChildEnv(options.env ?? process.env);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_CONCURRENT_CALLS);
  /** 実行中のプロセスグループの終了関数（S4） */
  const running = new Map<number, () => void>();
  let closed = false;
  let slots = 0;
  const waiters = new Set<() => void>();

  /** 同時実行の枠を deadline まで待つ（S5）。取れなければ false。 */
  const acquire = async (deadline: number): Promise<boolean> => {
    while (slots >= maxConcurrent) {
      if (closed) return false;
      const woke = await new Promise<boolean>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve(false);
        }, Math.max(0, deadline - Date.now()));
        waiters.add(wake);
      });
      if (!woke) return false;
    }
    if (closed) return false;
    slots += 1;
    return true;
  };
  const release = (): void => {
    slots -= 1;
    const next = waiters.values().next();
    if (!next.done) next.value();
  };

  /**
   * CLI を 1 回実行する。stdin は閉じ、プロセスグループを分けて起動し（detached）、
   * タイムアウトや出力超過のときはグループごと 1 回だけ SIGKILL する（t3 はシェルのラッパーで孫プロセスがあるため）。
   * 出力は呼び出し元に返すだけで、サーバーの stdout には流さない。
   */
  const run = (args: string[], deadline: number): Promise<RunResult> =>
    new Promise((resolve) => {
      const timeoutMs = deadline - Date.now();
      if (closed) {
        resolve({ kind: 'fail', reason: 'unavailable', message: 'サーバーを終了中です' });
        return;
      }
      if (timeoutMs <= 0) {
        resolve({ kind: 'fail', ...timeoutFailure(0) });
        return;
      }
      let settled = false;
      const finish = (r: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(cliPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (e) {
        resolve({ kind: 'fail', reason: 'spawn', message: e instanceof Error ? e.message : String(e) });
        return;
      }
      const pid = child.pid;
      let killed = false;
      const killGroup = (): void => {
        if (killed || pid === undefined) return;
        killed = true;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 既に終了している
          }
        }
      };
      if (pid !== undefined) running.set(pid, killGroup);
      const timer = setTimeout(() => {
        killGroup();
        finish({ kind: 'fail', ...timeoutFailure(timeoutMs) });
      }, timeoutMs);

      const out: Buffer[] = [];
      let outBytes = 0;
      let err = '';
      child.stdout.on('data', (d: Buffer) => {
        if (settled) return;
        outBytes += d.length;
        if (outBytes > MAX_STDOUT_BYTES) {
          killGroup();
          child.stdout.destroy();
          finish({ kind: 'fail', reason: 'output_too_large', message: `T3 CLI の出力が ${MAX_STDOUT_BYTES} バイトを超えました` });
          return;
        }
        out.push(d);
      });
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < MAX_STDERR_BYTES) err += d.toString('utf8');
      });
      child.on('error', (e) => {
        if (pid !== undefined) running.delete(pid);
        finish({ kind: 'fail', reason: 'spawn', message: e.message });
      });
      child.on('exit', () => {
        if (pid !== undefined) running.delete(pid);
      });
      child.on('close', (code) => {
        if (code === 0) finish({ kind: 'ok', stdout: Buffer.concat(out).toString('utf8') });
        else finish({ kind: 'exit', code, stderr: err.trim() });
      });
    });

  const call = async (args: string[], options: CallOptions | undefined): Promise<RunResult> => {
    const deadline = Date.now() + (options?.timeoutMs ?? defaultTimeout);
    if (!(await acquire(deadline))) {
      return closed
        ? { kind: 'fail', reason: 'unavailable', message: 'サーバーを終了中です' }
        : { kind: 'fail', ...timeoutFailure(options?.timeoutMs ?? defaultTimeout) };
    }
    try {
      return await run(args, deadline);
    } finally {
      release();
    }
  };

  const invalidId = (label: string, value: string): T3Failure => ({
    reason: 'invalid_argument',
    message: `${label} の形式が不正なため T3 CLI を呼びません: ${JSON.stringify(value.slice(0, 200))}`,
  });

  return {
    available: () => !closed,
    currentThreadId: () => current,

    async showThread(threadId: string, options?: CallOptions): Promise<ShowResult> {
      if (!isValidThreadId(threadId)) return { kind: 'error', ...invalidId('threadId', threadId) };
      const r = await call(['thread', 'show', threadId, '--json', '--messages', '0', '--log-level', 'none'], options);
      if (r.kind === 'fail') return { kind: 'error', reason: r.reason, message: r.message };
      if (r.kind === 'exit') {
        if (r.code === NOT_FOUND_EXIT_CODE && NOT_FOUND_PATTERN.test(r.stderr)) return { kind: 'missing' };
        return { kind: 'error', ...exitFailure(r) };
      }
      const parsed = showOutputSchema.safeParse(parseJson(r.stdout));
      if (!parsed.success) return { kind: 'error', reason: 'invalid_output', message: 'thread show の出力を解釈できません' };
      return { kind: 'found', thread: normalizeThread(parsed.data.thread) };
    },

    async listThreads(projectId: string, options?: CallOptions): Promise<ListResult> {
      if (!isValidThreadId(projectId)) return { ok: false, ...invalidId('projectId', projectId) };
      const r = await call(['thread', 'list', '--json', '--project', projectId, '--log-level', 'none'], options);
      if (r.kind === 'fail') return { ok: false, reason: r.reason, message: r.message };
      if (r.kind === 'exit') return { ok: false, ...exitFailure(r) };
      const parsed = parseJson(r.stdout);
      if (!Array.isArray(parsed)) return { ok: false, reason: 'invalid_output', message: 'thread list の出力を解釈できません' };
      return { ok: true, ...normalizeThreads(parsed) };
    },

    shutdown(): void {
      closed = true;
      for (const kill of running.values()) kill();
      running.clear();
      for (const wake of [...waiters]) wake();
    },
  };
}
