// SSS Extension 連携の確認：状態の判定、アカウントの読み取り、署名の取り出しと検算、プロファイルの追加。
// メモリ上のストレージと、偽の window.SSS で実行。 実行: npx tsx dev-tests/sss.test.ts
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
const win: any = {};
(globalThis as any).window = win;

const { Storage, WalletsHelper } = await import('../src/lib/storage');
const { readSssAccount, signWithSss, sssState, SssError, isSssAutoAdd, setSssAutoAdd } = await import('../src/lib/sss');
const { addressFromPublicKey, keyPairFromPrivateKey, signData } = await import('../src/lib/symbol/crypto');

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) pass += 1; else { fail += 1; console.error('NG:', name); } };
const rejects = async (p: Promise<unknown>, kind: string, name: string) => {
  try { await p; ok(false, name); } catch (e) { ok(e instanceof SssError && e.kind === kind, `${name} (${(e as any)?.kind ?? e})`); }
};

Storage.setup();

// --- 状態 ---
ok(sssState() === 'missing', '何も無ければ missing');
win.isAllowedSSS = () => false;
ok(sssState() === 'not_allowed', '入っているが許可なし');
win.isAllowedSSS = () => true;
ok(sssState() === 'not_allowed', '許可ありでも window.SSS が無ければ not_allowed');

const PK = 'AB'.repeat(32);
win.SSS = { activePublicKey: PK.toLowerCase(), activeNetworkType: 152, activeName: ' テスト ' };
ok(sssState() === 'ready', 'ready');
const acc = readSssAccount();
ok(acc !== null && acc.publicKey === PK && acc.network === 'testnet' && acc.name === 'テスト', 'アカウントを読む（大文字化・名前の前後の空白）');
ok(acc !== null && acc.address === addressFromPublicKey(PK, 152), 'アドレスは公開鍵から作り直す');
win.SSS.activeNetworkType = 104;
ok(readSssAccount()?.network === 'mainnet', 'メインネット');
win.SSS.activeNetworkType = 1;
ok(readSssAccount() === null, '知らないネットワークは読まない');
win.SSS.activeNetworkType = 152; win.SSS.activePublicKey = 'zz';
ok(readSssAccount() === null, '公開鍵が不正なら読まない');

// --- 署名 ---
const PRIV = '11'.repeat(32);
const pubKey: string = keyPairFromPrivateKey(PRIV).publicKey.toUpperCase();
win.SSS.activePublicKey = pubKey; win.SSS.activeNetworkType = 152;
const body = new Uint8Array(40).fill(7);
const signingPayload = new Uint8Array(72).fill(9);
const serializedTx = new Uint8Array(200).fill(1);
const goodSig: Uint8Array = Uint8Array.from(signData(PRIV, signingPayload));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const signedFrom = (sig: Uint8Array) => {
  const out = new Uint8Array(200); out.set(sig, 8); return toHex(out);
};
let received = '';
win.SSS.setTransactionByPayload = (p: string) => { received = p; };
win.SSS.requestSign = async () => ({ payload: signedFrom(goodSig) });
const sig = await signWithSss({ expectedPublicKey: pubKey, networkByte: 152, serializedTx, signingPayload });
ok(toHex(sig) === toHex(goodSig) && received === toHex(serializedTx), '署名を取り出し、拡張には署名前のトランザクションを渡す');
await rejects(signWithSss({ expectedPublicKey: 'CD'.repeat(32), networkByte: 152, serializedTx, signingPayload }), 'account_mismatch', '別のアカウントが選ばれている');
await rejects(signWithSss({ expectedPublicKey: pubKey, networkByte: 104, serializedTx, signingPayload }), 'network_mismatch', 'ネットワーク違い');
win.SSS.requestSign = async () => ({ payload: signedFrom(signData(PRIV, new Uint8Array(72).fill(8))) });
await rejects(signWithSss({ expectedPublicKey: pubKey, networkByte: 152, serializedTx, signingPayload }), 'signature_mismatch', '別の内容への署名は止める');
win.SSS.requestSign = async () => ({ payload: 'ABCD' });
await rejects(signWithSss({ expectedPublicKey: pubKey, networkByte: 152, serializedTx, signingPayload }), 'bad_response', '短すぎる応答');
win.SSS.requestSign = async () => { throw new Error('denied'); };
await rejects(signWithSss({ expectedPublicKey: pubKey, networkByte: 152, serializedTx, signingPayload }), 'rejected', '拒否');

// --- 設定 ---
ok(!isSssAutoAdd(), '自動追加は初期でオフ');
setSssAutoAdd(true); ok(isSssAutoAdd(), 'オン');
setSssAutoAdd(false); ok(!isSssAutoAdd(), 'オフに戻す');

// --- プロファイル ---
const first = await WalletsHelper.addSssProfile('SSS-1', pubKey.toLowerCase(), false);
ok(first.status === 'added' && first.wallet.sss && first.wallet.publicKey === pubKey && first.wallet.chain === 'symbol', '追加');
ok(first.wallet.keyless && first.wallet.encryptedSecret === '' && first.wallet.encryptedMnemonic === null, '秘密は持たない');
ok((await WalletsHelper.getActive('symbol'))?.id === first.wallet.id, '最初の1つは、使うアカウントになる');
ok(await WalletsHelper.isActiveSss(), 'アクティブが SSS');
const again = await WalletsHelper.addSssProfile('SSS-1b', pubKey, false);
ok(again.status === 'exists' && again.wallet.id === first.wallet.id, '同じ公開鍵は増やさない');
const second = await WalletsHelper.addSssProfile('SSS-2', 'CD'.repeat(32), false);
ok(second.status === 'added' && (await WalletsHelper.getActive('symbol'))?.id === first.wallet.id, '追加しても、使っているアカウントは変えない');
ok(second.wallet.profileKey !== first.wallet.profileKey, '1アカウント=1プロファイル');
await WalletsHelper.addSssProfile('SSS-2', 'CD'.repeat(32), true);
ok((await WalletsHelper.getActive('symbol'))?.id === second.wallet.id, 'activate なら切り替える');
ok(await WalletsHelper.hasSssProfile('cd'.repeat(32)), 'hasSssProfile');
ok((await Storage.loadWallets()).gets().filter((w) => w.sss).length === 2, '保存して読み直しても2つ（sss が残る）');

console.log(`sss: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
