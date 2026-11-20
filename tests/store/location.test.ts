import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitCommonDir, resolveLocation } from '../../src/store/location.js';
import { tempDir } from '../helpers/fixtures.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });

describe('resolveLocation', () => {
  const tmp = tempDir('kanban-loc-');
  const repo = join(tmp.path, 'repo');
  const worktree = join(tmp.path, 'wt');
  const home = join(tmp.path, 'home');

  beforeAll(() => {
    execFileSync('mkdir', ['-p', repo, home]);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  });

  afterAll(() => tmp.cleanup());

  it('git worktree を作って別ディレクトリから解決した DB パスが元リポジトリと一致する', () => {
    const main = resolveLocation({ env: {}, cwd: repo, homeDir: home });
    const wt = resolveLocation({ env: {}, cwd: worktree, homeDir: home });
    const subDir = join(worktree, 'packages', 'app');
    execFileSync('mkdir', ['-p', subDir]);
    const sub = resolveLocation({ env: {}, cwd: subDir, homeDir: home });
    expect(main.boardIdSource).toBe('git-common-dir');
    expect(wt.dbPath).toBe(main.dbPath);
    expect(wt.boardId).toBe(main.boardId);
    expect(sub.dbPath).toBe(main.dbPath);
    expect(main.basePath).toBe(realpathSync(join(repo, '.git')));
    expect(main.dbPath).toBe(join(home, '.t3-kanban', `${main.boardId}.db`));
    expect(gitCommonDir(worktree)).toBe(gitCommonDir(repo));
  });

  it('git リポジトリでなければ cwd から boardId を決める', () => {
    const plain = join(tmp.path, 'plain');
    execFileSync('mkdir', ['-p', plain]);
    const loc = resolveLocation({ env: {}, cwd: plain, homeDir: home });
    expect(loc.boardIdSource).toBe('cwd');
    expect(loc.dbPath.startsWith(join(home, '.t3-kanban'))).toBe(true);
  });

  it('KANBAN_BOARD_ID で boardId を上書きできる（DB パスもそれに従う）', () => {
    const loc = resolveLocation({ env: { KANBAN_BOARD_ID: 'my-board' }, cwd: repo, homeDir: home });
    expect(loc.boardId).toBe('my-board');
    expect(loc.boardIdSource).toBe('KANBAN_BOARD_ID');
    expect(loc.dbPath).toBe(join(home, '.t3-kanban', 'my-board.db'));
  });

  it('KANBAN_BOARD_ID のファイル名に使えない文字は置換する', () => {
    const loc = resolveLocation({ env: { KANBAN_BOARD_ID: '../evil/id' }, cwd: repo, homeDir: home });
    expect(loc.boardId).toBe('.._evil_id');
    expect(loc.dbPath).toBe(join(home, '.t3-kanban', '.._evil_id.db'));
  });

  it('KANBAN_DB_PATH で DB パスを上書きできる（boardId は git から決まる）', () => {
    const custom = join(tmp.path, 'custom', 'board.db');
    const loc = resolveLocation({ env: { KANBAN_DB_PATH: custom }, cwd: worktree, homeDir: home });
    expect(loc.dbPath).toBe(custom);
    expect(loc.boardId).toBe(resolveLocation({ env: {}, cwd: repo, homeDir: home }).boardId);
  });

  it('KANBAN_DB_PATH と KANBAN_BOARD_ID を同時に指定できる', () => {
    const custom = join(tmp.path, 'x.db');
    const loc = resolveLocation({ env: { KANBAN_DB_PATH: custom, KANBAN_BOARD_ID: 'b' }, cwd: repo, homeDir: home });
    expect(loc).toMatchObject({ dbPath: custom, boardId: 'b' });
  });

  it('相対の KANBAN_DB_PATH は cwd 基準で解決する', () => {
    const loc = resolveLocation({ env: { KANBAN_DB_PATH: 'data/k.db' }, cwd: repo, homeDir: home });
    expect(loc.dbPath).toBe(join(repo, 'data', 'k.db'));
  });
});
