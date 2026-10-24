// NEM「マルチシグの委任ハーベスト」（lib/nem/multisigHarvest.ts と tx.ts の importance）。
// 期待値は公式の nem-sdk（NanoWallet が使うもの）で作った値: リモート鍵の導出は NanoWallet の
// importanceTransfer（マルチシグ）の generateData と同じ式、署名前のバイト列は
// nem.model.transactions.prepare('importanceTransferTransaction')（isMultisig）+ serializeTransaction の出力。
// Run: npx tsx dev-tests/nem-multisig-harvest.test.ts（ネットワーク不要）
import {
  checkNemCustomRemoteKey, deriveNemMultisigRemoteAccount, loadNemMultisigRemote, planNemCustomRemote, planNemMultisigHarvest, saveNemMultisigRemote,
} from '../src/lib/nem/multisigHarvest';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, verifyNemSignature } from '../src/lib/nem/crypto';
import { signNemMultisigWrapped } from '../src/lib/nem/tx';
import { NEM_MIN_HARVEST_VESTED } from '../src/lib/nem/constants';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

// --- 1. リモート鍵の導出は NanoWallet（nem-sdk）と同じ ------------------------------------------------
// [連署者の秘密鍵, ネットワークbyte, マルチシグのアドレス, リモートの公開鍵, リモートのアドレス, リモートの秘密鍵]
const vectors: [string, number, string, string, string, string][] = [
  ['0000000000000000000000000000000000000000000000000000000000000001', 104, 'NBULEAUG2CZQISUR442HWA6UAKGWIXHDAABJA5FH', '4328456FF4248029DF7BB966052D467CA57937ACDB630C56BD150B5A4EE78741', 'ND3ZRCUY7XBT6P4DJIMVK3ZM5DJEKGENFGGZJOUQ', '7F017A87C2A90D51BB6F47ADA4599E2908336A89C75142B8AEB4E783E5E2C30E'],
  ['0000000000000000000000000000000000000000000000000000000000000001', 104, 'NBDBL7FN2AIPCVJ5TCO7YZJY7WKSWTR73WQAGNAK', 'FA24CE943CFA09D544CA33C63B0E821C4130B368F2E1108A4BC394D14EB4DC22', 'NAAZVWF6J5ET7XJ7645T4KKSOLHTGOBBC6OTANMP', '0460BCE009184173D5CD5C6C19CF054DA345FA05BB877B946BC11867CC54EA09'],
  ['8a1f4d6c3b2e5a7099c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2', 104, 'NBULEAUG2CZQISUR442HWA6UAKGWIXHDAABJA5FH', 'E47871F92D902F44EAAE4DA0D5A09735DF1A5D1DD736219A208BEE5CCC3C7B07', 'NDFZRI5HZOJOHI5SOECL3OPXB2FXFICFGPJTEGZ6', '367B20F1A7E96D0B7CE7A95299A347226EA34C01600847E81891C45CAF3E6A02'],
  ['8a1f4d6c3b2e5a7099c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2', 104, 'NBDBL7FN2AIPCVJ5TCO7YZJY7WKSWTR73WQAGNAK', '7E4B7480586353A27676FDA6EFF71A7D1FCFBBE0BF59D3BF32C248796980C2ED', 'NA2IOADKVGOFIGPYYQAHFW5RGPKJEV4ELCCVXRPN', 'E8D6331A14F625FB3AAA6E12AF6B4E8FC9CD2F51E688413EF88CC9D01A023D08'],
  ['f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f', 104, 'NBULEAUG2CZQISUR442HWA6UAKGWIXHDAABJA5FH', 'D51C511BA234680DFA4B588FF34FCB4A453B3539564742661F3554FC04B9A632', 'ND3BRDDTNHTYMJR4AV7BY4MKD35LDIBJ5GY3MC77', 'A19C1AAAC26D9F66F341F866B9ECF85E00CE9CBAD9585D142A4B57163DDFD205'],
  ['f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f', 104, 'NBDBL7FN2AIPCVJ5TCO7YZJY7WKSWTR73WQAGNAK', '6DE457C33B42346F69B773A706D8B07F25718EB59EA2C3E65C9D7B1C831162F7', 'NDH4I5QSI6KUZHWSJ73H5N5AFSRLRIAWY2IGB5XG', '3B983616AACE44FEB893FBC4304356BD222BABC36F4BC2B865BD1C9BD1544E00'],
  ['0000000000000000000000000000000000000000000000000000000000000001', 152, 'TBULEAUG2CZQISUR442HWA6UAKGWIXHDABJVIPS4', 'B7C490D92ED6B5D203A28E6A5F696F08F8DCFD04F367E3085B604CD18FC67AC7', 'TAMFQGOQYYCPGLATP6CK7GL27UXEDMU3J5C3ZEUO', 'F951616E17E9191D7655E92EEBCEC1E5BD5E8D5C03C79F56ECB5688D445F2E08'],
  ['0000000000000000000000000000000000000000000000000000000000000001', 152, 'TBDBL7FN2AIPCVJ5TCO7YZJY7WKSWTR73XSVBZ4A', '2CDBE06FAE0DCB6D8D99ED973EF222C41705755E4EF4E37689A70A7EB971C78F', 'TCXHEER7VP7TZILR6XCRQSG7EBQFBMXHSHEFDX5D', '53F12DA3E072423E6E7CB25A1C2DEF89F83C60B8D97FC8223954097CCBE89F0D'],
  ['8a1f4d6c3b2e5a7099c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2', 152, 'TBULEAUG2CZQISUR442HWA6UAKGWIXHDABJVIPS4', '402C78DDD7B6EF484FDB9C249735F7458B9943B77199F37D0F04C83E3F146E40', 'TDGDRLYQWB3DWVBTKJWMV5AWKD6ETWAZL5VM6OVZ', '974DDB6AA56AA2F54920D443575FC98D71433EFACA20DBBDCBC64E7CE29D0F03'],
  ['8a1f4d6c3b2e5a7099c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2', 152, 'TBDBL7FN2AIPCVJ5TCO7YZJY7WKSWTR73XSVBZ4A', '0AD6145410EFE7B19D5BE242CE0FAA6ABD9524522CA4721FDA8B1D222BB78143', 'TBZXJGWT3CGFNP63QQ7MVWQINE5N2YUIEHZIK2NR', '26CA1A01F4DA4BE6758D394472A6088A4DF3AF17EA12F630101F0AD7C9A3D80D'],
  ['f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f', 152, 'TBULEAUG2CZQISUR442HWA6UAKGWIXHDABJVIPS4', '7249378485B6D95BF483B2BFAAC12BAA1C1543958855F6561451DA33CC0D9A93', 'TBICDXBMZQ5IPVCXVMNPKOIAKBZ4OOMLYWYLEMDJ', '938503B1F94B9CA086D329F27361E55DB3494B707F8E09C2C60BF7AA1AD9BB05'],
  ['f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f', 152, 'TBDBL7FN2AIPCVJ5TCO7YZJY7WKSWTR73XSVBZ4A', '19156842409BE0633FFEA577A3B7C2A0292027FCEB365E7E62F63BE7C2D7FFBF', 'TB3EE3F7LNSZ7H2F6RMZS5ITQL7S72L6JLXRLRYX', '3457FF1D207E88A79830B8AEAB800753B8987C19B757ACABA5C860458143B007'],
];
for (const [cosigner, net, msig, remotePub, remoteAddr, remotePriv] of vectors) {
  const r = deriveNemMultisigRemoteAccount(cosigner, msig, net);
  ok(r.privateKey === remotePriv, 'remote private key matches nem-sdk (it is what the delegated-keys tab shows)', { msig });
  ok(r.publicKey === remotePub, 'remote public key matches nem-sdk', { msig, got: r.publicKey, want: remotePub });
  ok(r.address === remoteAddr, 'remote address matches nem-sdk', { got: r.address, want: remoteAddr });
}
{
  const [cosigner, net, msig] = vectors[0];
  const a = deriveNemMultisigRemoteAccount(cosigner, msig, net);
  ok(deriveNemMultisigRemoteAccount(cosigner, msig, net).privateKey === a.privateKey, 'derivation is deterministic');
  ok(deriveNemMultisigRemoteAccount(cosigner, msig.toLowerCase(), net).publicKey === a.publicKey, 'address case does not matter');
  ok(deriveNemMultisigRemoteAccount(cosigner, msig.replace(/(.{6})/g, '$1-'), net).publicKey === a.publicKey, 'hyphens in the address do not matter');
  ok(deriveNemMultisigRemoteAccount(vectors[2][0], msig, net).publicKey !== a.publicKey, 'another cosigner gets another remote account');
  ok(deriveNemMultisigRemoteAccount(cosigner, vectors[1][2], net).publicKey !== a.publicKey, 'another multisig account gets another remote account');
  ok(nemKeyPairFromPrivateKey(a.privateKey).publicKey === a.publicKey, 'the private key belongs to the public key');
  ok(a.publicKey !== nemKeyPairFromPrivateKey(cosigner).publicKey, 'the remote account is not the cosigner itself');
}

// --- 2. マルチシグ名義の重要性転送: 公式 nem-sdk と同じバイト列 ----------------------------------------
// 期待値は timeStamp / deadline の4か所（外側: 8, 56 バイト目、内側: 72, 120 バイト目）を 0 にしたもの。
const golden: [number, boolean, string][] = [
  [0x68, true, '04100000010000680000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000680000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff049020000000000000000000100000020000000e47871f92d902f44eaae4da0d5a09735df1a5d1dd736219a208bee5ccc3c7b07'],
  [0x68, false, '04100000010000680000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000680000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff049020000000000000000000200000020000000e47871f92d902f44eaae4da0d5a09735df1a5d1dd736219a208bee5ccc3c7b07'],
  [0x98, true, '04100000010000980000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000980000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff049020000000000000000000100000020000000402c78ddd7b6ef484fdb9c249735f7458b9943b77199f37d0f04c83e3f146e40'],
  [0x98, false, '04100000010000980000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000980000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff049020000000000000000000200000020000000402c78ddd7b6ef484fdb9c249735f7458b9943b77199f37d0f04c83e3f146e40'],
];
const COSIGNER = '8a1f4d6c3b2e5a7099c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2';
const cosigner = nemKeyPairFromPrivateKey(COSIGNER);
const msig = nemKeyPairFromPrivateKey('1111111111111111111111111111111111111111111111111111111111111111');
const zeroTimes = (b: Uint8Array) => { const c = Uint8Array.from(b); for (const o of [8, 56, 72, 120]) c.fill(0, o, o + 4); return hex(c); };
for (const [net, activate, want] of golden) {
  const remote = deriveNemMultisigRemoteAccount(COSIGNER, nemAddressFromPublicKey(msig.publicKey, net), net);
  const payload = JSON.parse(signNemMultisigWrapped(COSIGNER, cosigner.publicKey, net, msig.publicKey, { kind: 'importance', remotePublicKey: remote.publicKey, activate }));
  const data = unhex(payload.data);
  const label = `net=0x${net.toString(16)} activate=${activate}`;
  ok(zeroTimes(data) === want, `${label}: serialization equals nem-sdk`);
  ok(verifyNemSignature(cosigner.publicKey, data, unhex(payload.signature)), `${label}: the cosigner's signature verifies`);
  ok(data.length === 164, `${label}: size`, data.length);
}

// --- 2b. 公開鍵を指定したリモートアカウント（公式の「カスタムされた公開鍵を使用」）: 同じく nem-sdk と同じバイト列 --------
// 公開鍵は、公式の入力欄に例として出ているもの。
const CUSTOM = '0257b05f601ff829fdff84956fb5e3c65470a62375a1cc285779edd5ca3b42f6';
const goldenCustom: [number, boolean, string][] = [
  [0x68, true, '04100000010000680000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000680000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff0490200000000000000000001000000200000000257b05f601ff829fdff84956fb5e3c65470a62375a1cc285779edd5ca3b42f6'],
  [0x68, false, '04100000010000680000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000680000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff0490200000000000000000002000000200000000257b05f601ff829fdff84956fb5e3c65470a62375a1cc285779edd5ca3b42f6'],
  [0x98, true, '04100000010000980000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000980000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff0490200000000000000000001000000200000000257b05f601ff829fdff84956fb5e3c65470a62375a1cc285779edd5ca3b42f6'],
  [0x98, false, '04100000010000980000000020000000e511445873549b6c9ba8c050eb22ed74e4b0cb94618764742f2a6990cb8bfa66f049020000000000000000006400000001080000010000980000000020000000e59ef184a612d4c3c4d89b5950eb57262c69862b2f96e59c5043bf41765c482ff0490200000000000000000002000000200000000257b05f601ff829fdff84956fb5e3c65470a62375a1cc285779edd5ca3b42f6'],
];
for (const [net, activate, want] of goldenCustom) {
  const payload = JSON.parse(signNemMultisigWrapped(COSIGNER, cosigner.publicKey, net, msig.publicKey, { kind: 'importance', remotePublicKey: CUSTOM, activate }));
  const data = unhex(payload.data);
  const label = `custom key, net=0x${net.toString(16)} activate=${activate}`;
  ok(zeroTimes(data) === want, `${label}: serialization equals nem-sdk`);
  ok(verifyNemSignature(cosigner.publicKey, data, unhex(payload.signature)), `${label}: the cosigner's signature verifies`);
}

// --- 3. 画面が何を出すか（通信なし） -----------------------------------------------------------------
const base = {
  remoteStatus: 'INACTIVE' as const, vestedBalance: NEM_MIN_HARVEST_VESTED, hasPublicKey: true, isActivator: null as boolean | null,
  nodeStatus: 'UNKNOWN' as const, nodeValid: true, slotsFull: false, ownBalance: 10_000_000n, multisigBalance: 10_000_000n,
};
{
  const p = planNemMultisigHarvest(base);
  ok(p.canActivate && !p.canDeactivate && !p.canStart && !p.canStop, 'INACTIVE: only activate');
  ok(!planNemMultisigHarvest({ ...base, vestedBalance: NEM_MIN_HARVEST_VESTED - 1n }).canActivate, 'activate needs 10,000 vested XEM');
  ok(planNemMultisigHarvest({ ...base, vestedBalance: null }).canActivate, 'vested balance not loaded: not blocked');
  ok(!planNemMultisigHarvest({ ...base, hasPublicKey: false }).canActivate, 'activate needs the multisig account public key');
  ok(planNemMultisigHarvest({ ...base, ownBalance: 149_999n }).ownShort, 'own XEM short of the 0.15 XEM wrapper fee');
  ok(!planNemMultisigHarvest({ ...base, ownBalance: 150_000n }).ownShort, 'own XEM exactly enough');
  ok(planNemMultisigHarvest({ ...base, multisigBalance: 149_999n }).multisigShort, 'multisig XEM short of the 0.15 XEM inner fee');
  for (const s of ['ACTIVATING', 'DEACTIVATING', 'REMOTE', 'UNKNOWN'] as const) {
    const q = planNemMultisigHarvest({ ...base, remoteStatus: s, isActivator: true });
    ok(!q.canActivate && !q.canDeactivate && !q.canStart, `${s}: nothing to do yet`);
  }
  const act = { ...base, remoteStatus: 'ACTIVE' as const };
  ok(!planNemMultisigHarvest({ ...act, isActivator: null }).canStart && !planNemMultisigHarvest({ ...act, isActivator: null }).canDeactivate, 'ACTIVE, owner unknown: nothing until checked');
  ok(!planNemMultisigHarvest({ ...act, isActivator: false }).canStart && !planNemMultisigHarvest({ ...act, isActivator: false }).canDeactivate, 'ACTIVE, another cosigner owns it: no start / deactivate');
  const mine = planNemMultisigHarvest({ ...act, isActivator: true });
  ok(mine.canStart && mine.canDeactivate && !mine.canStop && !mine.canActivate, 'ACTIVE and mine: start or deactivate');
  const run = planNemMultisigHarvest({ ...act, isActivator: true, nodeStatus: 'UNLOCKED' });
  ok(run.canStop && !run.canStart && !run.canDeactivate, 'harvesting: stop only (stop the node before deactivating)');
  ok(planNemMultisigHarvest({ ...act, isActivator: false, nodeStatus: 'UNLOCKED' }).canStop, 'what the node runs can always be stopped');
  ok(!planNemMultisigHarvest({ ...act, isActivator: true, nodeValid: false }).canStart, 'start needs a valid node');
  ok(!planNemMultisigHarvest({ ...act, isActivator: true, slotsFull: true }).canStart, 'start needs a free slot');
  ok(!planNemMultisigHarvest({ ...act, isActivator: true, vestedBalance: 1n }).canStart, 'start needs enough vested XEM');
}

// --- 3b. 公開鍵の指定: 入力の検査と、送れるもの ------------------------------------------------------
{
  const MSIG_PUB = '1111111111111111111111111111111111111111111111111111111111111111'.toUpperCase();
  const good = '0257b05f601ff829fdff84956fb5e3c65470a62375a1cc285779edd5ca3b42f6';
  let c = checkNemCustomRemoteKey(good, MSIG_PUB);
  ok(c.valid && c.issue === null && c.key === good.toUpperCase(), 'a 64-hex key is valid and upper-cased');
  c = checkNemCustomRemoteKey(`  ${good}\n`, MSIG_PUB);
  ok(c.valid && c.key === good.toUpperCase(), 'surrounding spaces / newline are ignored');
  c = checkNemCustomRemoteKey('', MSIG_PUB);
  ok(!c.valid && c.issue === null, 'nothing entered: not valid, but no error shown yet');
  ok(checkNemCustomRemoteKey(good.slice(1), MSIG_PUB).issue === 'format', '63 characters');
  ok(checkNemCustomRemoteKey(good + '0', MSIG_PUB).issue === 'format', '65 characters');
  ok(checkNemCustomRemoteKey('G'.repeat(64), MSIG_PUB).issue === 'format', 'not hexadecimal');
  ok(checkNemCustomRemoteKey(good.replace(/^02/, '0x'), MSIG_PUB).issue === 'format', '0x prefix is not accepted');
  c = checkNemCustomRemoteKey(MSIG_PUB.toLowerCase(), MSIG_PUB);
  ok(!c.valid && c.issue === 'multisig_itself', 'the multisig account cannot be its own remote account');
  ok(checkNemCustomRemoteKey(good, null).valid, 'multisig public key unknown: still checks the format');

  const cb = { remoteStatus: 'INACTIVE' as const, vestedBalance: NEM_MIN_HARVEST_VESTED, hasPublicKey: true, keyValid: true, isActiveRemote: null as boolean | null };
  let q = planNemCustomRemote(cb);
  ok(q.canActivate && !q.canDeactivate, 'INACTIVE + valid key: activate only');
  ok(!planNemCustomRemote({ ...cb, keyValid: false }).canActivate, 'activate needs a valid key');
  ok(!planNemCustomRemote({ ...cb, vestedBalance: NEM_MIN_HARVEST_VESTED - 1n }).canActivate, 'activate needs 10,000 vested XEM');
  ok(!planNemCustomRemote({ ...cb, hasPublicKey: false }).canActivate, 'activate needs the multisig account public key');
  for (const s of ['ACTIVATING', 'DEACTIVATING', 'REMOTE', 'UNKNOWN'] as const) {
    q = planNemCustomRemote({ ...cb, remoteStatus: s, isActiveRemote: true });
    ok(!q.canActivate && !q.canDeactivate, `${s}: nothing to send`);
  }
  const act = { ...cb, remoteStatus: 'ACTIVE' as const };
  ok(!planNemCustomRemote({ ...act, isActiveRemote: null }).canDeactivate, 'ACTIVE, not confirmed by NIS yet: no deactivate');
  ok(!planNemCustomRemote({ ...act, isActiveRemote: false }).canDeactivate, 'ACTIVE, NIS says it is another account: no deactivate');
  q = planNemCustomRemote({ ...act, isActiveRemote: true });
  ok(q.canDeactivate && !q.canActivate, 'ACTIVE, NIS confirms the key: deactivate only');
  ok(!planNemCustomRemote({ ...act, isActiveRemote: true, keyValid: false }).canDeactivate, 'deactivate needs a valid key');
}

// --- 4. リモート公開鍵の記憶（公開鍵だけ・この端末だけ） --------------------------------------------
{
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  const [cos, net, address] = vectors[0];
  const r = deriveNemMultisigRemoteAccount(cos, address, net);
  ok(loadNemMultisigRemote('w1', address) === '', 'nothing remembered at first');
  saveNemMultisigRemote('w1', address, r.publicKey.toLowerCase());
  ok(loadNemMultisigRemote('w1', address) === r.publicKey, 'remembered (upper-cased)');
  ok(loadNemMultisigRemote('w1', address.toLowerCase()) === r.publicKey, 'address form does not matter');
  ok(loadNemMultisigRemote('w2', address) === '', 'per wallet');
  ok(![...store.values()].some((v) => v.toUpperCase() === r.privateKey), 'the private key is never stored');
  store.set([...store.keys()][0], 'not a key');
  ok(loadNemMultisigRemote('w1', address) === '', 'a broken value is ignored');
}

console.log(fails ? `\nFAILED ${fails} of ${checks} checks` : `OK (${checks} checks)`);
if (fails) process.exit(1);
