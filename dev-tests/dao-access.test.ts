// DAO のページに入る条件（DAO の ID だけ / ID とガバナンストークン）。ネットワークに触れずに確かめる。Run: npx tsx dev-tests/dao-access.test.ts
import { DAO_KEY, VOTE_INDEX_FIRST_KEY, canEnterDao, parseDaoAccess } from '../src/lib/dao/daoCore';
import {
  NEM_DAO_DESCRIPTION_MAX_BYTES, NEM_DAO_NAME_MAX_BYTES, buildDaoDescription, byteLength, canEnterNemDao, checkDaoName, parseDaoDescription,
} from '../src/lib/nem/daoCore';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- Symbol: メタデータ key 7 ---
ok(DAO_KEY.ACCESS_MODE === 7n, 'access key is 7');
ok(DAO_KEY.ACCESS_MODE < VOTE_INDEX_FIRST_KEY, 'key 7 is not read as a vote index');
ok(Object.values(DAO_KEY).filter((k) => k === DAO_KEY.ACCESS_MODE).length === 1, 'key 7 is not used by anything else');
ok(parseDaoAccess(undefined) === 'id' && parseDaoAccess(null) === 'id' && parseDaoAccess('') === 'id', 'no value → id only (old DAOs keep working)');
ok(parseDaoAccess('token') === 'token' && parseDaoAccess(' token ') === 'token', 'token');
ok(parseDaoAccess('id') === 'id' && parseDaoAccess('whatever') === 'id', 'id / unknown → id');

// --- 入れるか（Symbol / NEM 共通の考え方） ---
for (const [name, can] of [['symbol', canEnterDao], ['nem', canEnterNemDao]] as const) {
  ok(can('id', false, 0n), `${name}: id only → anyone enters`);
  ok(can('id', true, 0n), `${name}: id only → admin enters`);
  ok(!can('token', false, 0n), `${name}: token → no token, no entry`);
  ok(can('token', false, 1n), `${name}: token → holding 1 enters`);
  ok(can('token', false, 1_000_000n), `${name}: token → holding many enters`);
  ok(can('token', true, 0n), `${name}: token → admin enters even with 0`);
}

// --- NEM: 説明の中の access ---
const plain = buildDaoDescription('みんなのDAO');
ok(!plain.includes('access'), 'id only keeps the old description shape', plain);
ok(plain === buildDaoDescription('みんなのDAO', 'id'), 'default is id');
const tok = buildDaoDescription('みんなのDAO', 'token');
ok(tok.includes('"access":"token"'), 'token is written', tok);
ok(parseDaoDescription(plain)?.access === 'id', 'old description reads as id');
ok(parseDaoDescription(tok)?.access === 'token' && parseDaoDescription(tok)?.name === 'みんなのDAO', 'token round-trips with the name');
ok(parseDaoDescription(`KASANE-DAO:${JSON.stringify({ v: 1, name: 'x', access: 'weird' })}`)?.access === 'id', 'unknown access → id');
const longest = 'あ'.repeat(Math.floor(NEM_DAO_NAME_MAX_BYTES / 3));
ok(checkDaoName(longest) === null && byteLength(buildDaoDescription(longest, 'token')) <= NEM_DAO_DESCRIPTION_MAX_BYTES, 'longest name still fits with token');

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
