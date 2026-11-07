// NEM 版 DAO: ネットワークに触れずに確かめられる部分（説明の読み書き・費用・作成の手順・会員の整理）。Run: npx tsx dev-tests/nem-dao.test.ts
import {
  DAO_HANDOVER_FEE_MARGIN, DAO_MOSAIC_RENTAL, DAO_MULTISIG_FEE, DAO_NAMESPACE_RENTAL, DAO_PROVISION_FEE, DAO_SPARE, NEM_DAO_DESCRIPTION_MAX_BYTES, NEM_DAO_MARK,
  NEM_DAO_NAME_MAX_BYTES, NEM_DAO_SUPPLY, balanceTarget, buildDaoDescription, byteLength, checkDaoName, daoDepositMicro, depositTopUp, governanceMosaicId,
  isGovernanceMosaicId, isNemDaoId, isValidDaoNamespace, nextCreateStep, normalizeMembers, parseDaoDescription, parseRecipients, parseTokenAmount,
} from '../src/lib/nem/daoCore';
import {
  NEM_DAO_EXCHANGE_MARK, NEM_DAO_FULFIL_MARK, NEM_DAO_ITEM_MARK, buildExchangeMessage, buildFulfilMessage, buildItemDescription, checkNewItem, exchangeCost,
  parseExchangeMessage, parseFulfilMessage, parseItemDescription, requestStatus,
} from '../src/lib/nem/daoCore';
import type { DaoCreationState } from '../src/lib/nem/daoCore';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- 説明（DAO の名前を入れる場所） ---
const desc = buildDaoDescription('みんなのDAO');
ok(desc.startsWith(NEM_DAO_MARK), 'description starts with the mark');
ok(parseDaoDescription(desc)?.name === 'みんなのDAO', 'name round-trips', parseDaoDescription(desc));
ok(parseDaoDescription('普通のモザイクの説明') === null, 'plain description is not a DAO');
ok(parseDaoDescription(undefined) === null && parseDaoDescription('') === null, 'empty is not a DAO');
ok(parseDaoDescription(`${NEM_DAO_MARK}{broken`) === null, 'broken JSON is not a DAO');
ok(parseDaoDescription(`${NEM_DAO_MARK}${JSON.stringify({ v: 1, name: 5 })}`) === null, 'name must be text');
ok(parseDaoDescription(buildDaoDescription('a"b\\c'))?.name === 'a"b\\c', 'quotes and backslashes survive');

// --- 名前のチェック ---
ok(checkDaoName('') === 'empty' && checkDaoName('   ') === 'empty', 'empty name');
ok(checkDaoName('ok') === null, 'plain name ok');
ok(checkDaoName('あ'.repeat(34)) === 'too_long', 'name over 100 bytes (34 * 3 = 102)');
ok(checkDaoName('あ'.repeat(33)) === null, 'name at 99 bytes is ok');
ok(byteLength(buildDaoDescription('あ'.repeat(33))) <= NEM_DAO_DESCRIPTION_MAX_BYTES, 'the longest allowed name still fits the 512-byte description');
ok(NEM_DAO_NAME_MAX_BYTES === 100, 'name limit matches the Symbol DAO');
// 引用符が多い名前は JSON で長くなる: 100 バイトに収まっても説明が 512 を超えうるか確かめる
const worst = '"'.repeat(100);
ok(checkDaoName(worst) === null || checkDaoName(worst) === 'description_too_long', 'worst-case escaping is judged, not crashed');
ok(byteLength(buildDaoDescription(worst)) <= NEM_DAO_DESCRIPTION_MAX_BYTES || checkDaoName(worst) === 'description_too_long', 'a name whose description would exceed 512 bytes is refused');

// --- ネームスペース・ID ---
ok(isValidDaoNamespace('mydao') && isValidDaoNamespace('my-dao_1') && isValidDaoNamespace('a'), 'valid namespaces');
ok(!isValidDaoNamespace('') && !isValidDaoNamespace('MyDao') && !isValidDaoNamespace('-dao') && !isValidDaoNamespace('my.dao') && !isValidDaoNamespace('a'.repeat(17)), 'invalid namespaces');
ok(isValidDaoNamespace('a'.repeat(16)), '16 characters is the limit');
ok(governanceMosaicId('mydao') === 'mydao:gov', 'governance mosaic id');
ok(isGovernanceMosaicId('mydao:gov') && isGovernanceMosaicId('MYDAO:GOV') && !isGovernanceMosaicId('mydao:point'), 'governance id check');
ok(isNemDaoId('A'.repeat(64)) && isNemDaoId('a'.repeat(64)) && !isNemDaoId('A'.repeat(63)) && !isNemDaoId('G'.repeat(64)), 'DAO id is 64 hex');

// --- 費用: 100 + 10 + 0.15*2 + 1 + 0.5 + 2 = 113.8 XEM ---
ok(daoDepositMicro() === 113_800_000n, 'deposit is 113.8 XEM', daoDepositMicro());
ok(daoDepositMicro() >= DAO_NAMESPACE_RENTAL + DAO_MOSAIC_RENTAL + DAO_PROVISION_FEE * 2n + DAO_MULTISIG_FEE, 'deposit covers every payment the DAO account makes');
ok(DAO_SPARE > 0n && DAO_HANDOVER_FEE_MARGIN > 0n, 'margins are positive');
ok(NEM_DAO_SUPPLY === 1_000_000n, 'same supply as the Symbol DAO');

// --- 作成の手順（途中から再開できる） ---
const base: DaoCreationState = { balance: 0n, namespaceOwned: false, mosaicDefined: false, daoHolds: 0n, multisig: false };
ok(nextCreateStep(base) === 'deposit', 'fresh: deposit first');
ok(depositTopUp(base) === daoDepositMicro(), 'fresh: the whole deposit', depositTopUp(base));
const funded = { ...base, balance: daoDepositMicro() };
ok(nextCreateStep(funded) === 'namespace' && depositTopUp(funded) === 0n, 'funded: namespace');
const afterNs = { ...funded, balance: daoDepositMicro() - DAO_NAMESPACE_RENTAL - DAO_PROVISION_FEE, namespaceOwned: true };
ok(nextCreateStep(afterNs) === 'mosaic', 'after the namespace: mosaic (the remaining balance still covers it)', balanceTarget(afterNs));
const afterMosaic = { ...afterNs, balance: 5_000_000n, mosaicDefined: true, daoHolds: NEM_DAO_SUPPLY };
ok(nextCreateStep(afterMosaic) === 'handover', 'after the mosaic: hand the tokens over');
const afterHandover = { ...afterMosaic, daoHolds: 0n };
ok(nextCreateStep(afterHandover) === 'multisig', 'after the handover: multisig');
ok(nextCreateStep({ ...afterHandover, multisig: true }) === null, 'multisig: done');
// 資金が足りなくなっていたら、どの段階でも先に入金
const poor = { ...afterNs, balance: 1_000_000n };
ok(nextCreateStep(poor) === 'deposit' && depositTopUp(poor) === balanceTarget(poor) - 1_000_000n, 'resume with too little XEM tops up first', depositTopUp(poor));
ok(nextCreateStep({ ...afterHandover, balance: 100_000n }) === 'deposit', 'not even the multisig fee: top up');
ok(nextCreateStep({ ...base, balance: 999_999_999_999n, multisig: true }) === null, 'a finished DAO is never touched again');

// --- 会員 ---
const members = normalizeMembers([
  { address: 'NB', amount: 5n }, { address: 'NA', amount: 5n }, { address: 'NC', amount: 0n }, { address: 'ND', amount: 100n }, { address: 'NB', amount: 2n },
]);
ok(members.map((m) => m.address).join() === 'ND,NB,NA', 'sorted by holding, zero dropped, duplicates merged', members);
ok(members[1].amount === 7n, 'duplicate addresses add up');

ok(parseRecipients('NA-AA\nna-aa, NB;  NC\t').join() === 'NAAA,NB,NC', 'recipients: split, uppercase, hyphens removed, deduplicated', parseRecipients('NA-AA\nna-aa, NB;  NC\t'));
ok(parseRecipients('  ').length === 0, 'blank recipients');
ok(parseTokenAmount('10') === 10n && parseTokenAmount(' 7 ') === 7n, 'amount parses');
ok(parseTokenAmount('0') === null && parseTokenAmount('-1') === null && parseTokenAmount('1.5') === null && parseTokenAmount('') === null && parseTokenAmount('abc') === null, 'bad amounts');
ok(parseTokenAmount('1000001') === null && parseTokenAmount('1000000') === 1_000_000n, 'amount is capped at the supply');

// --- ポイント・特典（第 3 段階） ---
const DAO = 'AB'.repeat(32);
const pt = buildItemDescription({ dao: DAO, kind: 'point', name: 'ポイント' });
ok(pt.startsWith(NEM_DAO_ITEM_MARK) && parseItemDescription(pt)?.kind === 'point' && parseItemDescription(pt)?.name === 'ポイント', 'point description round-trips');
const rw = buildItemDescription({ dao: DAO, kind: 'reward', name: 'ステッカー', description: '非売品', point: 'mydao:pt', cost: '30' });
const rwDoc = parseItemDescription(rw);
ok(rwDoc?.kind === 'reward' && rwDoc.point === 'mydao:pt' && rwDoc.cost === '30' && rwDoc.description === '非売品', 'reward description round-trips', rwDoc);
ok(parseItemDescription(buildItemDescription({ dao: DAO.toLowerCase(), kind: 'point', name: 'x' }))?.dao === DAO, 'DAO id is upper-cased');
ok(parseItemDescription('KASANE-DAO:{"name":"x"}') === null && parseItemDescription('') === null && parseItemDescription(`${NEM_DAO_ITEM_MARK}{bad`) === null, 'other descriptions are not items');
ok(parseItemDescription(buildItemDescription({ dao: 'short', kind: 'point', name: 'x' })) === null, 'a DAO id that is not 64 hex is refused');
ok(parseItemDescription(buildItemDescription({ dao: DAO, kind: 'reward', name: 'x', point: 'a:b', cost: '0' })) === null, 'a reward must cost something');
ok(parseItemDescription(buildItemDescription({ dao: DAO, kind: 'reward', name: 'x', cost: '5' })) === null, 'a reward must name its point');
ok(parseItemDescription(buildItemDescription({ dao: DAO, kind: 'reward', name: 'x', point: 'a:b', cost: '-5' })) === null, 'negative cost refused');

const okItem = { kind: 'reward' as const, name: 'ステッカー', part: 'sticker', amount: 100n, description: '', point: 'mydao.pt:point', cost: 30n, dao: DAO };
ok(checkNewItem(okItem).length === 0, 'a good reward passes');
ok(checkNewItem({ ...okItem, kind: 'point', point: '', cost: null }).length === 0, 'a point needs no cost or point');
ok(checkNewItem({ ...okItem, name: ' ' }).includes('name_empty'), 'empty name');
ok(checkNewItem({ ...okItem, name: 'あ'.repeat(17) }).includes('name_long'), 'name over 50 bytes');
ok(checkNewItem({ ...okItem, amount: null }).includes('amount'), 'amount missing');
ok(checkNewItem({ ...okItem, cost: null }).includes('cost'), 'cost missing');
ok(checkNewItem({ ...okItem, point: 'nocolon' }).includes('point'), 'point mosaic id malformed');
ok(checkNewItem({ ...okItem, point: 'mydao:pt' }).includes('point'), 'a point must live in a child namespace (root:name is refused)');
ok(checkNewItem({ ...okItem, part: '' }).includes('namespace_part') && checkNewItem({ ...okItem, part: 'Bad.Name' }).includes('namespace_part'), 'child namespace name is checked');
ok(checkNewItem({ ...okItem, description: 'あ'.repeat(67) }).includes('description_long'), 'description over 200 bytes');
ok(checkNewItem({ ...okItem, name: 'あ'.repeat(16), description: 'あ'.repeat(66), point: 'a'.repeat(60) + '.' + 'b'.repeat(60) + ':' + 'c'.repeat(31) }).includes('description_too_long'), 'the whole description must fit in 512 bytes');

ok(exchangeCost(3n, 30n) === 90n, 'cost = quantity * cost');
const em = buildExchangeMessage('mydao:sticker', 3n);
ok(em.startsWith(NEM_DAO_EXCHANGE_MARK), 'exchange message mark');
ok(parseExchangeMessage(em)?.quantity === 3n && parseExchangeMessage(em)?.reward === 'mydao:sticker', 'exchange message round-trips');
ok(parseExchangeMessage('hello') === null && parseExchangeMessage(null) === null && parseExchangeMessage(buildExchangeMessage('a:b', 0n)) === null, 'bad exchange messages');
ok(parseExchangeMessage(`${NEM_DAO_EXCHANGE_MARK}{"reward":"a:b","qty":"1.5"}`) === null, 'fractional quantity refused');
const hash = 'ab'.repeat(32);
const fm = buildFulfilMessage(hash);
ok(fm.startsWith(NEM_DAO_FULFIL_MARK) && parseFulfilMessage(fm) === hash.toUpperCase(), 'fulfil message carries the request hash');
ok(parseFulfilMessage('x') === null && parseFulfilMessage(`${NEM_DAO_FULFIL_MARK}{"req":"zz"}`) === null, 'bad fulfil messages');

ok(requestStatus({ paid: 90n, quantity: 3n, cost: 30n, fulfilled: false }) === 'ready', 'exactly enough → ready');
ok(requestStatus({ paid: 120n, quantity: 3n, cost: 30n, fulfilled: false }) === 'ready', 'more than enough → ready');
ok(requestStatus({ paid: 89n, quantity: 3n, cost: 30n, fulfilled: false }) === 'short', 'one point short');
ok(requestStatus({ paid: 90n, quantity: 3n, cost: null, fulfilled: false }) === 'unknown_item', 'unknown reward');
ok(requestStatus({ paid: 0n, quantity: 3n, cost: 30n, fulfilled: true }) === 'done', 'fulfilled wins');

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
