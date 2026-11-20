// テスト用の偽 T3 CLI。本物の t3 と同じ引数・出力形式で、シナリオ（FAKE_T3_SCENARIO の JSON ファイル）に従って応答する。
// シナリオ:
//   threads:      thread show が返すスレッド（全項目）
//   listIds:      thread list に出す threadId（省略時は parentThreadId のないもの）
//   hangShow:     show で応答しない threadId
//   hangList:     list で応答しない
//   invalidShow:  show で JSON でない出力を返す threadId
//   failShow:     show で「存在しない」以外の理由で失敗する threadId（終了コード 2）
//   exit127Show:  show で終了コード 127 と `command not found` / `not found` を返す threadId（交互）
//   missingExit2: show で「no longer available」を終了コード 2 で返す threadId
//   hugeShow:     show で 5MB の出力を返す threadId
//   rawList:      thread list の出力をこの値にする（不正な要素を混ぜる用）
//   log:          呼び出しを 1 行 1 JSON で追記するファイル
import { appendFileSync, readFileSync } from 'node:fs';

const SHOW_ONLY_KEYS = ['branch', 'worktreePath', 'pendingRequestCount', 'archived', 'activeRunId', 'runCount'];

const scenarioPath = process.env.FAKE_T3_SCENARIO;
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : { threads: [] };
const args = process.argv.slice(2);
if (scenario.log) {
  appendFileSync(scenario.log, `${JSON.stringify({ pid: process.pid, args, envKeys: Object.keys(process.env).sort() })}\n`);
}

const hang = () => setInterval(() => {}, 1000);
const threads = scenario.threads ?? [];

if (args[0] === 'thread' && args[1] === 'show') {
  const id = args[2];
  if ((scenario.hangShow ?? []).includes(id)) {
    hang();
  } else if ((scenario.invalidShow ?? []).includes(id)) {
    process.stdout.write('this is not json');
  } else if ((scenario.missingExit2 ?? []).includes(id)) {
    process.stderr.write(`Thread ${id} is no longer available.\n`);
    process.exit(2);
  } else if ((scenario.hugeShow ?? []).includes(id)) {
    process.stdout.write('x'.repeat(5 * 1024 * 1024));
  } else if ((scenario.exit127Show ?? []).includes(id)) {
    process.stderr.write(id.endsWith('a') ? 'sh: t3: command not found\n' : 'exec: t3: not found\n');
    process.exit(127);
  } else if ((scenario.failShow ?? []).includes(id)) {
    process.stderr.write('connect ECONNREFUSED 127.0.0.1:3773\n');
    process.exit(2);
  } else {
    const thread = threads.find((t) => t.threadId === id);
    if (thread === undefined) {
      process.stderr.write(`Thread ${id} is no longer available.\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ thread, messages: [] }));
  }
} else if (args[0] === 'thread' && args[1] === 'list') {
  if (scenario.hangList) {
    hang();
  } else if (scenario.rawList !== undefined) {
    process.stdout.write(JSON.stringify(scenario.rawList));
  } else {
    const project = args[args.indexOf('--project') + 1];
    const listed = threads
      .filter((t) => (scenario.listIds ? scenario.listIds.includes(t.threadId) : !t.parentThreadId))
      .filter((t) => t.projectId === project)
      .map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !SHOW_ONLY_KEYS.includes(k))));
    process.stdout.write(JSON.stringify(listed));
  }
} else {
  process.stderr.write(`fake t3: unsupported command ${args.join(' ')}\n`);
  process.exit(64);
}
