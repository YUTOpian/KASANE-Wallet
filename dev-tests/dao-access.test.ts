// DAO のページに入る条件（DAO の ID だけ / ID とガバナンストークン）。ネットワークに触れずに確かめる。Run: npx tsx dev-tests/dao-access.test.ts
import { DAO_KEY, VOTE_INDEX_FIRST_KEY, canEnterDao, parseDaoAccess } from '../src/lib/dao/daoCore';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- Symbol: メタデータ key 7 ---
ok(DAO_KEY.ACCESS_MODE === 7n, 'access key is 7');
ok(DAO_KEY.ACCESS_MODE < VOTE_INDEX_FIRST_KEY, 'key 7 is not read as a vote index');
ok(Object.values(DAO_KEY).filter((k) => k === DAO_KEY.ACCESS_MODE).length === 1, 'key 7 is not used by anything else');
ok(parseDaoAccess(undefined) === 'id' && parseDaoAccess(null) === 'id' && parseDaoAccess('') === 'id', 'no value → id only (old DAOs keep working)');
ok(parseDaoAccess('token') === 'token' && parseDaoAccess(' token ') === 'token', 'token');
ok(parseDaoAccess('id') === 'id' && parseDaoAccess('whatever') === 'id', 'id / unknown → id');

// --- 入れるか ---
for (const [name, can] of [['symbol', canEnterDao]] as const) {
  ok(can('id', false, 0n), `${name}: id only → anyone enters`);
  ok(can('id', true, 0n), `${name}: id only → admin enters`);
  ok(!can('token', false, 0n), `${name}: token → no token, no entry`);
  ok(can('token', false, 1n), `${name}: token → holding 1 enters`);
  ok(can('token', false, 1_000_000n), `${name}: token → holding many enters`);
  ok(can('token', true, 0n), `${name}: token → admin enters even with 0`);
}

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
