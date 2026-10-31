// 署名依頼の危険警告（中身の判定）: 送金先・連署者に追加されるアドレスのアドレス帳での扱い、エイリアス宛て、マルチシグの設定変更、
// 読み取れないトランザクション。通信なし。
// Run: npx tsx dev-tests/sign-risk.test.ts
import { analyzeSignRisks, hasDanger, shortRiskAddress } from '../src/lib/signRisk';
import type { Trust } from '../src/lib/addressBook';
import type { PartialItem } from '../src/lib/symbol/multisigApi';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const ACC = 'NAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BLK = 'NBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const UNK = 'NCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const FRD = 'NDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const trust = (a: string): Trust => (a === BLK ? 'black' : a === UNK ? 'unknown' : a === FRD ? 'white' : 'self');
const transfer = (recipient: string, encrypted = false): PartialItem => ({ kind: 'transfer', account: ACC, recipient, mosaics: [{ symbol: 'XYM', amount: '1' }], message: '', encrypted });
const multisig = (o: Partial<{ minApprovalDelta: number; minRemovalDelta: number; additions: string[]; deletions: string[] }>): PartialItem =>
  ({ kind: 'multisig', account: ACC, minApprovalDelta: 0, minRemovalDelta: 0, additions: [], deletions: [], ...o });
const codes = (items: PartialItem[]) => analyzeSignRisks(items, trust).map((r) => `${r.level}:${r.code}`);

// transfers
ok(codes([transfer(FRD)]).length === 0, 'a transfer to a whitelisted address raises nothing');
ok(codes([transfer('NEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE')]).length === 0, 'a transfer to one of my own accounts raises nothing');
ok(codes([transfer(ACC)]).length === 0, 'a transfer to the account itself raises nothing');
ok(codes([transfer(BLK)]).join() === 'danger:transfer_to_blocked', 'a transfer to a blocked address is a danger', codes([transfer(BLK)]));
ok(hasDanger(analyzeSignRisks([transfer(BLK)], trust)), 'hasDanger is true for it');
ok(codes([transfer(UNK)]).join() === 'warning:transfer_to_unknown', 'a transfer to an unknown address is a warning');
ok(codes([transfer('@85BBEA6CC462B244')]).join() === 'warning:transfer_alias_recipient', 'an alias recipient cannot be checked: a warning');
ok(codes([transfer(FRD, true)]).join() === 'info:transfer_encrypted', 'an encrypted message is an info');
ok(!hasDanger(analyzeSignRisks([transfer(UNK)], trust)), 'a warning is not a danger');

// multisig modification
ok(codes([multisig({})]).join() === 'warning:multisig_change', 'any multisig change is a warning');
ok(codes([multisig({ minApprovalDelta: -1 })]).join() === 'warning:multisig_change,warning:multisig_threshold_down', 'lowering the approval count is a warning of its own', codes([multisig({ minApprovalDelta: -1 })]));
ok(codes([multisig({ minRemovalDelta: -1 })]).includes('warning:multisig_threshold_down'), 'lowering the removal count too');
ok(!codes([multisig({ minApprovalDelta: 1 })]).includes('warning:multisig_threshold_down'), 'raising it is not');
ok(codes([multisig({ additions: [BLK] })])[0] === 'danger:multisig_add_blocked', 'a blocked cosigner being added is a danger, listed first', codes([multisig({ additions: [BLK] })]));
ok(codes([multisig({ additions: [UNK] })]).includes('warning:multisig_add_unknown'), 'an unknown cosigner being added is a warning');
ok(!codes([multisig({ additions: [FRD] })]).some((c) => c.includes('add_')), 'a whitelisted cosigner being added raises nothing of its own');

// other kinds
ok(codes([{ kind: 'other', account: ACC, type: 0x424d }]).join() === 'warning:other_unreadable', 'an unreadable transaction is a warning');
ok(analyzeSignRisks([{ kind: 'other', account: ACC, type: 0x424d }], trust)[0].params?.type === '0x424D', 'its type is shown in hex');
ok(codes([{ kind: 'restriction', account: ACC, rule: { kind: 'address', direction: 'incoming' }, mode: 'block', additions: [], deletions: [] } as unknown as PartialItem]).join() === 'warning:restriction_change', 'a restriction change is a warning');
ok(codes([{ kind: 'metadata', account: ACC, targetType: 0, targetAddress: ACC, key: '0', valueSizeDelta: 0, changeHex: '' } as unknown as PartialItem]).length === 0, 'a metadata entry raises nothing');

// de-duplication and order
const many = codes([transfer(UNK), transfer(UNK), transfer(BLK), transfer(BLK)]);
ok(many.join() === 'danger:transfer_to_blocked,warning:transfer_to_unknown', 'the same warning is listed once, danger first', many);
const two = analyzeSignRisks([transfer(UNK), transfer('NFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')], (a) => (a.startsWith('NF') || a === UNK ? 'unknown' : 'self'));
ok(two.length === 2, 'two different unknown recipients are two warnings');
ok(shortRiskAddress(UNK) === 'NCCCCC…CCCC', 'short address', shortRiskAddress(UNK));
ok(analyzeSignRisks([], trust).length === 0, 'an empty request raises nothing');

console.log(`${checks - fails}/${checks} passed`);
process.exit(fails === 0 ? 0 : 1);
