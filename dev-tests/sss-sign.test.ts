// SSS Extension で署名する、署名関数共通の包み（signViaSss）の確認。
// 偽の window.SSS が、本物の秘密鍵で署名して返す。SSS 経由の結果が、秘密鍵で直接署名した結果と完全に同じになること、
// 内容が途中で変わったり、署名が合わなかったりしたら止まることを確かめる。 実行: npx tsx dev-tests/sss-sign.test.ts
const win: any = {};
(globalThis as any).window = win;

const { signMosaicSupplyChange, symbolSigningPayload } = await import('../src/lib/symbol/tx');
const { signMaybeSss } = await import('../src/lib/symbol/sssSign');
const { keyPairFromPrivateKey, signData } = await import('../src/lib/symbol/crypto');
const { getNetworkConfig } = await import('../src/lib/symbol/network');
const { SssError } = await import('../src/lib/sss');

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) pass += 1; else { fail += 1; console.error('NG:', name); } };

const cfg = getNetworkConfig('testnet');
const PRIV = '22'.repeat(32);
const pubKey = keyPairFromPrivateKey(PRIV).publicKey.toUpperCase();
const params = {
  signerPublicKey: pubKey, networkByte: cfg.networkByte, mosaicId: '0123456789ABCDEF',
  action: 'increase' as const, delta: 1000n, feeMultiplier: 100, deadline: 1_000_000n,
};
const toBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

// 偽の SSS：渡された署名前のトランザクションに、本物の鍵で署名して、署名入りのペイロードを返す
let received = '';
win.isAllowedSSS = () => true;
win.SSS = {
  activePublicKey: pubKey, activeNetworkType: cfg.networkByte, activeName: 'test',
  setTransactionByPayload: (p: string) => { received = p; },
  requestSign: async () => {
    const tx = toBytes(received);
    const signature = Uint8Array.from(signData(PRIV, symbolSigningPayload(cfg.generationHash, tx)));
    tx.set(signature, 8);
    return { payload: toHex(tx) };
  },
};

const direct = signMosaicSupplyChange(PRIV, cfg.generationHash, params);
const viaSss = await signMaybeSss('', pubKey, cfg.networkByte, () => signMosaicSupplyChange('', cfg.generationHash, params));
ok(viaSss.payload === direct.payload && viaSss.hash === direct.hash, 'SSS 経由の署名が、秘密鍵で直接署名した結果と完全に同じ');
ok(received.slice(16, 16 + 128) === '0'.repeat(128), 'SSS には署名前（署名がゼロ）のトランザクションを渡す');

// 別のアカウントが選ばれている
win.SSS.activePublicKey = 'CD'.repeat(32);
try { await signMaybeSss('', pubKey, cfg.networkByte, () => signMosaicSupplyChange('', cfg.generationHash, params)); ok(false, '別のアカウントなら止まる'); }
catch (e) { ok(e instanceof SssError && e.kind === 'account_mismatch', '別のアカウントなら止まる'); }
win.SSS.activePublicKey = pubKey;

// SSS が別の鍵で署名した（署名が合わない）
const realSign = win.SSS.requestSign;
win.SSS.requestSign = async () => {
  const tx = toBytes(received);
  tx.set(Uint8Array.from(signData('33'.repeat(32), symbolSigningPayload(cfg.generationHash, tx))), 8);
  return { payload: toHex(tx) };
};
try { await signMaybeSss('', pubKey, cfg.networkByte, () => signMosaicSupplyChange('', cfg.generationHash, params)); ok(false, '別の鍵の署名は止まる'); }
catch (e) { ok(e instanceof SssError && e.kind === 'signature_mismatch', '別の鍵の署名は止まる'); }
win.SSS.requestSign = realSign;

// 署名関数の中身が呼ぶたびに変わる（時刻・乱数を使っている）と、送らない
let n = 0;
try { await signMaybeSss('', pubKey, cfg.networkByte, () => signMosaicSupplyChange('', cfg.generationHash, { ...params, delta: BigInt(1000 + n++) })); ok(false, '内容が変わったら止まる'); }
catch (e) { ok(e instanceof SssError && e.kind === 'signature_mismatch', '内容が変わったら止まる'); }

// 空の鍵で、SSS を通さずに署名しようとしても、署名されない
try { signMosaicSupplyChange('', cfg.generationHash, params); ok(false, '差し替えの外では空の鍵は使えない'); }
catch { ok(true, '差し替えの外では空の鍵は使えない'); }

console.log(`sss-sign: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
