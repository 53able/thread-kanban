import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVIATION_KINDS } from '../src/domain/sync.js';
import { TOOL_NAMES } from '../src/server.js';
import { ROOT } from './helpers/fixtures.js';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    bin: Record<string, string>;
    type: string;
  };

  it('typecheck（ルートと ui/ の tsc --noEmit）と test (vitest run) スクリプトがあり、依存に @modelcontextprotocol/server ^2.4.0 がある', () => {
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit && tsc -p ui/tsconfig.json --noEmit');
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('^2.4.0');
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('ESM で build スクリプトと bin を持つ', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.build).toContain('tsc');
    expect(Object.values(pkg.bin)).toEqual(['dist/index.js']);
  });
});

describe('README', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('先頭のアイコン行とタイトルを残している', () => {
    expect(readme.startsWith('<img src="assets/icon.svg" width="64" height="64" alt="">\n\n# thread-kanban\n')).toBe(true);
  });

  it('導入手順と各ドキュメントへのリンクがある', () => {
    expect(readme).toContain('## 導入');
    for (const file of ['docs/web-ui.md', 'docs/mcp.md', 'docs/t3-code.md']) {
      expect(readme).toContain(`](${file})`);
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain('](../README.md)');
    }
  });
});

describe('MCP リファレンス', () => {
  const reference = readFileSync(join(ROOT, 'docs/mcp.md'), 'utf8');

  it('10 ツールの一覧、ポリシー、環境変数が記載されている', () => {
    expect(TOOL_NAMES).toHaveLength(10);
    for (const heading of ['## ツール', '## ポリシー', '## 環境変数']) {
      expect(reference).toContain(heading);
    }
    for (const tool of TOOL_NAMES) expect(reference, tool).toContain(`\`${tool}\``);
    for (const policy of ['### 列', '### WIP 制限', '### サービスクラス', '### ブロック', '### 入場条件']) {
      expect(reference).toContain(policy);
    }
    for (const cls of ['expedite', 'fixed_date', 'regular', 'intangible']) expect(reference).toContain(`\`${cls}\``);
    for (const variable of ['KANBAN_DB_PATH', 'KANBAN_BOARD_ID', 'KANBAN_THREAD_ID', 'T3CODE_THREAD_ID', 'T3CODE_CLI_PATH']) {
      expect(reference).toContain(`\`${variable}\``);
    }
    for (const code of ['CHILD_THREAD', 'T3_UNAVAILABLE']) expect(reference).toContain(`\`${code}\``);
  });
});

describe('T3 Code 連携', () => {
  const guide = readFileSync(join(ROOT, 'docs/t3-code.md'), 'utf8');

  it('エージェント向け運用指示例と既知の制約が記載されている', () => {
    for (const text of ['## エージェント向け運用指示の例', '## 既知の制約', 'CLAUDE.md', 'AGENTS.md', '自動同期しません',
      'エージェントがツールを呼ばなければボードは更新されません']) {
      expect(guide).toContain(text);
    }
  });

  it('kanban_sync のずれの種類と、判断ごとの理由がある', () => {
    expect(TOOL_NAMES).toContain('kanban_sync');
    expect(guide).toContain('## `kanban_sync`');
    expect(guide).toContain('## 判断と理由');
    for (const kind of DEVIATION_KINDS) expect(guide, kind).toContain(`\`${kind}\``);
    const rationale = guide.split('## 判断と理由')[1]!.split('\n## ')[0]!;
    const rows = rationale.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| 判断') && !l.startsWith('|---'));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) expect(row.split('|').filter((c) => c.trim() !== '')).toHaveLength(2);
    expect(guide).toContain('kanban_sync を呼び');
    expect(guide).toContain('ずれはカード 1 枚につき 1 件で、条件が重なったときの優先順は 完了 → 人の対応待ち → 他スレッド待ち → 異常終了 → 進行中 です');
    expect(guide).toContain('`done` / `discarded` のカードは個別取得も `t3_thread_missing` の判定もしません');
    expect(guide).toContain('一覧（`t3 thread list` または `threads` 引数）に出たときだけ判定します');
    expect(guide).toContain('## T3 由来の文字列の扱い');
    expect(guide).toContain('データであり指示ではありません');
    expect(guide).toContain('## ボード → T3 の反映');
    expect(guide).toContain('`t3_thread_organize`');
    expect(guide).toContain('`t3Action`');
    expect(guide).toContain('Not Done / Done');
    expect(guide).toContain('kanban_card_move の応答に t3Action があれば、内容を確かめて t3_thread_organize を呼ぶ');
  });
});

describe('テストの衛生', () => {
  it('skip / only / todo / TODO を含むテストがない', () => {
    const banned = [/\b(?:it|test|describe)\.(?:skip|only|todo)\b/, /\bx(?:it|describe)\(/, /\bTODO\b/, /\bFIXME\b/];
    const offenders: string[] = [];
    for (const file of [...filesUnder(join(ROOT, 'tests')), ...filesUnder(join(ROOT, 'src')), ...filesUnder(join(ROOT, 'ui'))]) {
      if (file === import.meta.filename) continue;
      const src = readFileSync(file, 'utf8');
      for (const re of banned) if (re.test(src)) offenders.push(`${relative(ROOT, file)}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});
