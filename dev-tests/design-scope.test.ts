// Run: npx tsx dev-tests/design-scope.test.ts
// The Ledger / view-only profile screens must look exactly like the start screen: the fixed neutral KASANE
// design (it does not follow the saved chain; the dark / light / business setting DOES apply) and no side menu.
import { hasNoMenuPath, isOnboardingPath, ONBOARDING_PREFIXES, resolveDesign } from '../src/theme/designScope';

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

check('/wallet/ledger is in the start-screen design group', isOnboardingPath('/wallet/ledger'));
for (const chain of ['symbol', 'nem'] as const) {
  for (const mode of ['dark', 'light'] as const) {
    const a = resolveDesign('/wallet/ledger', mode, chain);
    const b = resolveDesign('/welcome', mode, chain);
    check(`/wallet/ledger = /welcome design (saved ${chain}, ${mode})`, a.mode === b.mode && a.chain === b.chain && a.chain === 'base' && a.mode === mode);
  }
}
check('/wallet/ledger has no side menu', hasNoMenuPath('/wallet/ledger'));
// 閲覧用プロファイルの作成画面も、スタート画面と同じ固定デザイン（保存されたチェーンの色に染まらない）。
check('/wallet/watch is in the start-screen design group', isOnboardingPath('/wallet/watch'));
for (const chain of ['symbol', 'nem'] as const) {
  for (const mode of ['dark', 'light'] as const) {
    const a = resolveDesign('/wallet/watch', mode, chain);
    const b = resolveDesign('/welcome', mode, chain);
    check(`/wallet/watch = /welcome design (saved ${chain}, ${mode})`, a.mode === b.mode && a.chain === b.chain && a.chain === 'base');
  }
}
check('every start-screen-group path has no side menu', ONBOARDING_PREFIXES.every((p) => hasNoMenuPath(p)));
check('the view-only profile screen still has no menu', hasNoMenuPath('/wallet/watch'));
check('in-wallet screens still have the menu', !hasNoMenuPath('/top') && !hasNoMenuPath('/send/confirmation') && !hasNoMenuPath('/account'));
check('in-wallet screens still follow the saved chain / mode', resolveDesign('/top', 'light', 'nem').chain === 'nem' && resolveDesign('/top', 'light', 'nem').mode === 'light');
// mijin v2: the Symbol chain on the mijin network gets its own tint (like Symbol / NEM); everything else is unchanged.
check('Symbol + mijin in-wallet = mijin tint, dark / light follows the setting', resolveDesign('/top', 'dark', 'symbol', 'mijin').chain === 'mijin' && resolveDesign('/top', 'dark', 'symbol', 'mijin').mode === 'dark' && resolveDesign('/top', 'light', 'symbol', 'mijin').mode === 'light');
check('Symbol + mainnet / testnet keep the Symbol tint', resolveDesign('/top', 'dark', 'symbol', 'mainnet').chain === 'symbol' && resolveDesign('/top', 'dark', 'symbol', 'testnet').chain === 'symbol');
check('NEM never gets the mijin look', resolveDesign('/top', 'dark', 'nem', 'mijin').chain === 'nem');
check('start screens stay neutral on mijin (the light / dark setting still applies)', resolveDesign('/welcome', 'light', 'symbol', 'mijin').chain === 'base' && resolveDesign('/welcome', 'light', 'symbol', 'mijin').mode === 'light');
check('omitting the network keeps the old behaviour', resolveDesign('/top', 'dark', 'symbol').chain === 'symbol');
// ビジネス theme: in-wallet screens follow it (with the chain); the start screens follow it too but stay neutral (no chain tint).
check('in-wallet screens follow the business theme', resolveDesign('/top', 'business', 'nem').mode === 'business' && resolveDesign('/top', 'business', 'symbol', 'mijin').mode === 'business');
check('start screens follow the business theme without a chain tint', resolveDesign('/welcome', 'business', 'symbol').mode === 'business' && resolveDesign('/welcome', 'business', 'symbol').chain === 'base');
console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
(globalThis as unknown as { process: { exit(n: number): void } }).process.exit(failed === 0 ? 0 : 1);
