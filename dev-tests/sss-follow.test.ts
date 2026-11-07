// SSS のネットワークにアプリを合わせる判定の確認（lib/sssFollow.ts）。 実行: npx tsx dev-tests/sss-follow.test.ts
import { sssFollow } from '../src/lib/sssFollow';
import type { SssFollowInput } from '../src/lib/sssFollow';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) pass += 1; else { fail += 1; console.error('NG:', name); } };
const base: SssFollowInput = { sssNetwork: 'testnet', appNetwork: 'mainnet', appChain: 'symbol', profile: {}, sssNetworkJustChanged: true };
const run = (o: Partial<SssFollowInput>) => sssFollow({ ...base, ...o });

// 通常のプロファイル（ニーモニックなど）: 食い違い＋SSS のネットワークが分かった・切り替わったとき、SSS に合わせる
ok(run({}).network === 'testnet', '通常プロファイル: メインネット→SSS のテストネットに合わせる');
ok(run({ sssNetwork: 'mainnet', appNetwork: 'testnet' }).network === 'mainnet', '通常プロファイル: テストネット→メインネット');
ok(run({ appNetwork: 'testnet' }).network === null, '通常プロファイル: すでに同じなら切り替えない');
ok(run({ profile: null }).network === 'testnet', 'プロファイルがまだ無くても合わせる（作成前の画面）');
ok(run({}).switchChainToSymbol === false, '通常プロファイル: チェーンは変えない');
// 手動で切り替えた分は戻さない（SSS が変わっていないとき）
ok(run({ sssNetworkJustChanged: false }).network === null, '通常プロファイル: SSS が変わっていなければ、手動の切り替えを戻さない');
// 合わせないもの
ok(run({ profile: { watchOnly: true } }).network === null, '閲覧用プロファイルは合わせない');
ok(run({ appChain: 'nem' }).network === null, 'NEM は合わせない');
ok(run({ appNetwork: 'mijin' }).network === null, 'mijin v2 は合わせない');
// SSS のプロファイル: 常に合わせる（SSS が変わったかどうかによらない）
ok(run({ profile: { sss: true }, sssNetworkJustChanged: false }).network === 'testnet', 'SSS プロファイル: 変わっていなくても食い違えば合わせる');
ok(run({ profile: { sss: true }, appNetwork: 'mijin' }).network === 'testnet', 'SSS プロファイル: mijin からも SSS に合わせる');
ok(run({ profile: { sss: true }, appNetwork: 'testnet' }).network === null, 'SSS プロファイル: 同じなら切り替えない');
ok(run({ profile: { sss: true }, appChain: 'nem' }).switchChainToSymbol === true, 'SSS プロファイル: NEM なら Symbol に切り替える');
ok(run({ profile: { sss: true } }).switchChainToSymbol === false, 'SSS プロファイル: すでに Symbol ならそのまま');

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
