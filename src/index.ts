#!/usr/bin/env node
// stdout は MCP プロトコル専用。console.log / info / debug / warn も stderr へ流す。
console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.warn = console.error;

const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
const { createKanbanServer } = await import('./server.js');
const { resolveLocation } = await import('./store/location.js');
const { KanbanStore } = await import('./store/sqlite.js');
const { createCliGateway } = await import('./t3/cli.js');

const location = resolveLocation({ env: process.env, cwd: process.cwd() });
const store = KanbanStore.open({ path: location.dbPath, boardId: location.boardId });
process.stderr.write(
  `[thread-kanban] board=${location.boardId} (${location.boardIdSource}${location.basePath !== null ? `: ${location.basePath}` : ''}) db=${location.dbPath}\n`,
);

// 環境変数の trim と空判定はここだけで行う
const envValue = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

// T3 CLI は起動時には呼ばない（呼ぶのは kanban_card_add / kanban_sync の実行時だけ）
const t3 = createCliGateway({ cliPath: envValue('T3CODE_CLI_PATH'), currentThreadId: envValue('T3CODE_THREAD_ID') });
const server = createKanbanServer({
  store,
  defaultThreadId: envValue('KANBAN_THREAD_ID') ?? envValue('T3CODE_THREAD_ID'),
  t3,
});

// 終了時に実行中の T3 CLI のプロセスグループを残さない（S4）
const shutdown = (): void => {
  t3.shutdown();
  store.close();
};
process.on('exit', () => t3.shutdown());
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

const transport = new StdioServerTransport();
transport.onclose = shutdown;
await server.connect(transport);
