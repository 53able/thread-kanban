#!/usr/bin/env node
// 振り分けだけを行う。`thread-kanban ui` は Web UI、それ以外は stdio の MCP サーバー
if (process.argv[2] === 'ui') await import('./web/main.js');
else await import('./mcp-main.js');
