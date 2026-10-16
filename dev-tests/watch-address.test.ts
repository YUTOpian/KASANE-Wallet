// 閲覧用プロファイル：アドレスの判定と、メインネット⇔テストネットのアドレス変換の確認。
// 実行: npx tsx dev-tests/watch-address.test.ts
import { addressFromPublicKey, convertAddressNetwork } from '../src/lib/symbol/crypto';
import { nemAddressFromPublicKey, convertNemAddressNetwork } from '../src/lib/nem/crypto';
import { addressBody, parseWatchAddress } from '../src/lib/watchAddress';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

const keys = [
  '3B9670B5CB19C893694FC49B461CE489BF9588BE16DBE8DC29CF06338133DEE6',
  'C0C0FFEE00112233445566778899AABBCCDDEEFF00112233445566778899AABB',
  '0000000000000000000000000000000000000000000000000000000000000001',
];

for (const key of keys) {
  // Symbol: 公開鍵から求めたアドレスと、変換で求めたアドレスが一致する
  const symMain = addressFromPublicKey(key, 0x68);
  const symTest = addressFromPublicKey(key, 0x98);
  check(`symbol main->test ${key.slice(0, 6)}`, convertAddressNetwork(symMain, 0x98) === symTest);
  check(`symbol test->main ${key.slice(0, 6)}`, convertAddressNetwork(symTest, 0x68) === symMain);
  check(`symbol same network ${key.slice(0, 6)}`, convertAddressNetwork(symMain, 0x68) === symMain);

  // NEM
  const nemMain = nemAddressFromPublicKey(key, 0x68);
  const nemTest = nemAddressFromPublicKey(key, 0x98);
  check(`nem main->test ${key.slice(0, 6)}`, convertNemAddressNetwork(nemMain, 0x98) === nemTest);
  check(`nem test->main ${key.slice(0, 6)}`, convertNemAddressNetwork(nemTest, 0x68) === nemMain);

  // 判定：長さでチェーン、先頭の文字（バイト）でネットワーク。ハイフン・小文字でもよい
  const a = parseWatchAddress(symMain);
  check('parse symbol mainnet', a?.chain === 'symbol' && a.network === 'mainnet' && a.address === symMain);
  const b = parseWatchAddress(symTest);
  check('parse symbol testnet', b?.chain === 'symbol' && b.network === 'testnet');
  const c = parseWatchAddress(nemMain);
  check('parse nem mainnet', c?.chain === 'nem' && c.network === 'mainnet' && c.address === nemMain);
  const d = parseWatchAddress(nemTest);
  check('parse nem testnet', d?.chain === 'nem' && d.network === 'testnet');
  const hyphenated = (nemMain.match(/.{1,6}/g) as string[]).join('-').toLowerCase();
  check('parse nem hyphenated lower-case', parseWatchAddress(hyphenated)?.address === nemMain);

  // 同じアカウントなら、ネットワークが違っても同じ「本体」
  check('body equal across networks (symbol)', addressBody('symbol', symMain) === addressBody('symbol', symTest));
  check('body equal across networks (nem)', addressBody('nem', nemMain) === addressBody('nem', nemTest));
}

// 壊れたアドレスは弾く（1文字違い・長さ違い・空）
const good = addressFromPublicKey(keys[0], 0x68);
const mid = good[10] === 'A' ? 'B' : 'A';
const broken = good.slice(0, 10) + mid + good.slice(11);
check('reject checksum mismatch', parseWatchAddress(broken) === null);
// 末尾の文字は一部のビットが使われない：同じアドレスを表す別の綴りが他にもあるが、保存は必ず正規の形になる
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const spellings = B32.split('').map((ch) => good.slice(0, -1) + ch).filter((x) => {
  const parsed = parseWatchAddress(x);
  return parsed !== null && addressBody('symbol', parsed.address) === addressBody('symbol', good);
});
check('alternative last-char spellings exist', spellings.length > 1, `found ${spellings.length}`);
check('every spelling is stored as the canonical form', spellings.every((x) => parseWatchAddress(x)?.address === good));
check('canonical stored form is stable', parseWatchAddress(good)?.address === good);
check('reject too short', parseWatchAddress(good.slice(0, 20)) === null);
check('reject empty', parseWatchAddress('') === null);
check('convert rejects invalid', convertAddressNetwork('NOTANADDRESS', 0x98) === null);

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
