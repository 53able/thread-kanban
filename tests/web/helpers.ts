import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { createKanbanServer } from '../../src/server.js';
import { KanbanStore } from '../../src/store/sqlite.js';
import { unavailableGateway } from '../../src/t3/gateway.js';
import type { Clock } from '../../src/domain/types.js';
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/web/server.js';
import { ROOT } from '../helpers/fixtures.js';

export const STATIC_DIR = join(ROOT, 'dist', 'web-static');
export const TOKEN = 'test-token-0123456789abcdef';
export const VERSION = '0.1.0';

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function httpRequest(port: number, path: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** 認証済みのクライアント（Host / cookie / Origin / Content-Type を付ける）。 */
export class UiClient {
  constructor(
    readonly port: number,
    readonly token = TOKEN,
  ) {}

  get baseHeaders(): Record<string, string> {
    return { Host: `127.0.0.1:${this.port}`, Cookie: `tk_${this.port}=${this.token}` };
  }

  get(path: string): Promise<HttpResponse> {
    return httpRequest(this.port, path, { headers: this.baseHeaders });
  }

  post(path: string, body: unknown): Promise<HttpResponse> {
    return httpRequest(this.port, path, {
      method: 'POST',
      headers: { ...this.baseHeaders, Origin: `http://127.0.0.1:${this.port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  card(key: string, threadId: string, action: string): string {
    return `/api/boards/${encodeURIComponent(key)}/cards/${encodeURIComponent(threadId)}/${action}`;
  }

  stream(key: string, lastEventId?: number): SseClient {
    const q = lastEventId === undefined ? '' : `?lastEventId=${lastEventId}`;
    return new SseClient(this.port, `/api/boards/${encodeURIComponent(key)}/stream${q}`, this.baseHeaders);
  }
}

export interface SseMessage {
  event: string;
  id: string | null;
  data: any;
}

/** text/event-stream を読み取るテスト用のクライアント。 */
export class SseClient {
  readonly messages: SseMessage[] = [];
  comments = 0;
  status: number | null = null;
  /** サーバーが応答を閉じた */
  ended = false;
  private buffer = '';
  private readonly req: ReturnType<typeof request>;
  private waiters: (() => void)[] = [];

  constructor(port: number, path: string, headers: Record<string, string>) {
    this.req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      this.status = res.statusCode ?? 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        this.buffer += chunk;
        let i: number;
        while ((i = this.buffer.indexOf('\n\n')) >= 0) {
          const block = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 2);
          this.parse(block);
        }
      });
      res.on('end', () => {
        this.ended = true;
        this.notify();
      });
      this.notify();
    });
    this.req.on('error', () => {});
    this.req.end();
  }

  private parse(block: string): void {
    let event = 'message';
    let id: string | null = null;
    const data: string[] = [];
    let isComment = true;
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      isComment = false;
      const [field, ...rest] = line.split(':');
      const value = rest.join(':').replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (isComment) {
      this.comments += 1;
    } else {
      this.messages.push({ event, id, data: JSON.parse(data.join('\n')) });
    }
    this.notify();
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** 条件を満たすまで待つ（満たしたメッセージの位置を返す）。 */
  async waitFor(pred: (messages: SseMessage[]) => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.messages)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE の待機が時間切れ: ${JSON.stringify(this.messages.map((m) => m.event))}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** サーバーが応答を閉じるまで待つ。 */
  async waitForEnd(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('SSE が閉じられないまま時間切れ');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  snapshots(): any[] {
    return this.messages.filter((m) => m.event === 'snapshot').map((m) => m.data);
  }

  events(): any[] {
    return this.messages.filter((m) => m.event === 'events').flatMap((m) => m.data.events);
  }

  close(): void {
    this.req.destroy();
  }
}

export async function startUi(options: Partial<UiServerOptions> & { homeDir: string; clock: Clock }): Promise<{ server: UiServer; client: UiClient }> {
  const server = await createUiServer({
    staticDir: STATIC_DIR,
    pollMs: 30,
    rebuildIntervalMs: 60_000,
    port: 0,
    version: VERSION,
    token: TOKEN,
    log: () => {},
    ...options,
  });
  return { server, client: new UiClient(server.port, options.token ?? TOKEN) };
}

/** createKanbanServer をインメモリのトランスポートでつないだ MCP クライアント。 */
export interface McpHarness {
  store: KanbanStore;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function startMcp(path: string, boardId: string, clock: Clock): Promise<McpHarness> {
  const store = KanbanStore.open({ path, boardId, clock });
  const server = createKanbanServer({ store, clock, t3: unavailableGateway() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'ui-parity', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    store,
    call: (name, args = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

export function withoutKeys<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
