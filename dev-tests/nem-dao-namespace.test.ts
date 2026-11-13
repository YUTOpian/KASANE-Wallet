// NEM 版 DAO: ネームスペースの期限の判定（通信なし）。Run: npx tsx dev-tests/nem-dao-namespace.test.ts
import { DAO_BLOCKS_PER_DAY, DAO_RENEW_WINDOW_BLOCKS, daoNamespaceOf, daoNamespaceStatus, isDaoDissolved } from '../src/lib/nem/daoCore';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

ok(daoNamespaceOf('mydao:gov') === 'mydao', 'namespace part of the governance mosaic id');
ok(DAO_RENEW_WINDOW_BLOCKS === 43_200, 'window is 30 days of blocks');

const rows = (remainingBlocks?: number) => [{ name: 'mydao', remainingBlocks }, { name: 'mydao.sub', remainingBlocks }];
ok(daoNamespaceStatus(rows(300 * DAO_BLOCKS_PER_DAY), 'mydao').state === 'ok', 'far from expiry is ok');
ok(daoNamespaceStatus(rows(DAO_RENEW_WINDOW_BLOCKS + 1), 'mydao').state === 'ok', 'one block outside the window is ok');
const soon = daoNamespaceStatus(rows(DAO_RENEW_WINDOW_BLOCKS), 'mydao');
ok(soon.state === 'soon' && soon.remainingDays === 30, 'exactly 30 days is soon', soon);
ok(daoNamespaceStatus(rows(1), 'mydao').state === 'soon', 'one block left is soon');
ok(daoNamespaceStatus(rows(0), 'mydao').state === 'expired', 'zero left is expired');
ok(daoNamespaceStatus(rows(-5000), 'mydao').state === 'expired', 'negative is expired');
ok(daoNamespaceStatus(rows(undefined), 'mydao').state === 'unknown', 'unknown height is unknown');
ok(daoNamespaceStatus([], 'mydao').state === 'lost', 'namespace not owned any more is lost');
ok(daoNamespaceStatus([{ name: 'other', remainingBlocks: 10 }], 'mydao').state === 'lost', 'only other namespaces is lost');
ok(daoNamespaceStatus([{ name: 'mydao.sub', remainingBlocks: 10 }], 'mydao').state === 'lost', 'a sub-namespace is not the root');

// 解散の扱い: 期限切れと、持ち主でなくなった（lost）だけ。期限が近い・確認できない・読み込み前は解散にしない。
ok(isDaoDissolved(daoNamespaceStatus(rows(0), 'mydao')), 'expired is dissolved');
ok(isDaoDissolved(daoNamespaceStatus([], 'mydao')), 'lost is dissolved');
ok(!isDaoDissolved(daoNamespaceStatus(rows(10), 'mydao')), 'soon is not dissolved');
ok(!isDaoDissolved(daoNamespaceStatus(rows(undefined), 'mydao')), 'unknown is not dissolved');
ok(!isDaoDissolved(daoNamespaceStatus(rows(10 * DAO_BLOCKS_PER_DAY * 30), 'mydao')), 'ok is not dissolved');
ok(!isDaoDissolved(null), 'not loaded yet is not dissolved');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 1 - 1 : 1);
