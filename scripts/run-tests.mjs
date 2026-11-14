#!/usr/bin/env node
// dev-tests/*.test.ts をまとめて実行する。各テストは「失敗があれば終了コード 1」で終わる作りなので、その終了コードで判定する。
//
//   npm test                 すべて
//   npm test -- links nem    ファイル名に "links" か "nem" を含むものだけ
//   npm test -- --list       一覧だけ表示
//
// 環境変数: TEST_JOBS（同時実行数、既定 4）/ TEST_TIMEOUT_MS（1本あたりの上限、既定 120000）
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'dev-tests');
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 120_000);
const JOBS = Math.max(1, Number(process.env.TEST_JOBS ?? Math.min(4, availableParallelism())));
const inActions = process.env.GITHUB_ACTIONS === 'true';
const assetLoader = pathToFileURL(join(root, 'scripts', 'asset-loader.mjs')).href;

// 依存パッケージが入っていないときは、125 本分のエラーを出さずに、ここで 1 回だけ伝える。
if (!existsSync(join(root, 'node_modules', 'tsx'))) {
  console.error('node_modules がありません（または tsx が入っていません）。先に `npm ci` を実行してください。');
  process.exit(1);
}

const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('--'));
const all = readdirSync(testDir).filter((f) => f.endsWith('.test.ts')).sort();
const files = filters.length > 0 ? all.filter((f) => filters.some((q) => f.includes(q))) : all;

if (files.length === 0) {
  console.error('該当するテストがありません:', filters.join(' '));
  process.exit(1);
}
if (args.includes('--list')) {
  console.log(files.join('\n'));
  process.exit(0);
}

let seq = 0;
function runOne(file) {
  return new Promise((done) => {
    const started = Date.now();
    // 出力はパイプではなく一時ファイルに書かせる。テストが process.exit() で終わるとき、パイプだと
    // 最後の数十行が届かないことがある（失敗の行が消える）。ファイルなら全部残る。
    const logPath = join(tmpdir(), `kasane-test-${process.pid}-${seq++}.log`);
    const fd = openSync(logPath, 'w');
    // tsx を --import で読み込む（npx を挟まないぶん速い）。asset-loader は、画像・音声の import を Node で読めるようにする。
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', assetLoader, join('dev-tests', file)], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', fd, fd],
    });
    let timedOut = false;
    let spawnError = '';
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      closeSync(fd);
      let output = '';
      try {
        output = readFileSync(logPath, 'utf8');
        unlinkSync(logPath);
      } catch {}
      output += spawnError;
      done({ file, ok: code === 0 && !timedOut, code, timedOut, output, ms: Date.now() - started });
    };
    child.on('error', (err) => {
      spawnError = String(err);
      finish(1);
    });
    child.on('close', finish);
  });
}

// 失敗したテストの出力から、見るべき行を抜き出す。PASS を大量に出すテストでは、末尾だけだと FAIL の行が切れるため。
function failureExcerpt(output) {
  const lines = output.trimEnd().split('\n');
  const key = lines.filter((l) => /FAIL|ERROR|Error|✘/.test(l));
  const head = [...new Set(key)].slice(0, 40);
  const tail = lines.slice(-30).filter((l) => !head.includes(l));
  return [...head, ...(head.length > 0 ? ['  …（末尾）'] : []), ...tail].join('\n');
}

const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const r = await runOne(file);
    results.push(r);
    const sec = (r.ms / 1000).toFixed(1);
    if (r.ok) {
      console.log(`PASS  ${file}  (${sec}s)`);
    } else {
      console.log(`FAIL  ${file}  (${sec}s)${r.timedOut ? '  timeout' : `  exit ${r.code}`}`);
      if (inActions) console.log(`::group::${file} の出力`);
      console.log(failureExcerpt(r.output));
      if (inActions) {
        console.log('::endgroup::');
        console.log(`::error file=dev-tests/${file}::テストが失敗しました（${r.timedOut ? 'timeout' : `exit ${r.code}`}）`);
      }
    }
  }
}

console.log(`${files.length} 本のテストを実行します（同時 ${Math.min(JOBS, files.length)}）\n`);
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failed.length > 0) {
  console.log('失敗:\n' + failed.map((r) => `  - ${r.file}`).join('\n'));
  process.exit(1);
}
