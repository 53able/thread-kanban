import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { DIST_INDEX, ROOT } from './fixtures.js';

export interface Harness {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  stderr(): string;
  close(): Promise<void>;
}

/** 親プロセスから子プロセスへ引き継ぐ環境変数（許可リスト。T3CODE_* や KANBAN_* は引き継がない）。 */
const INHERITED_ENV = ['PATH'] as const;

/**
 * テストで起動する子プロセスの環境変数（R6）。
 * 親プロセス（T3 Code 上で動くテストランナーなど）の T3CODE_* は必ず除く。本物の T3 CLI を呼ばないため。
 * T3 を使うテストだけ、extra で偽 CLI の T3CODE_CLI_PATH などを明示的に渡す。
 */
export function childEnv(extra: Record<string, string> = {}, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const v = parent[key];
    if (v !== undefined) base[key] = v;
  }
  return { ...base, ...extra };
}

/**
 * ビルド済みサーバー（dist/index.js）を子プロセスで起動し、stdio で MCP クライアントを接続する。
 * HOME も一時ディレクトリに向けるため ~/.t3-kanban には触れない。
 */
export async function startServer(env: Record<string, string>, cwd = ROOT): Promise<Harness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_INDEX],
    env: childEnv(env),
    cwd,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'kanban-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    stderr: () => stderr,
    close: () => client.close(),
  };
}

export function structured(result: CallToolResult): Record<string, any> {
  const sc = result.structuredContent;
  if (typeof sc !== 'object' || sc === null) throw new Error(`structuredContent がありません: ${JSON.stringify(result)}`);
  return sc as Record<string, any>;
}

export function text(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
