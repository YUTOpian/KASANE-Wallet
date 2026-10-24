// 「ログインのたびにパスワード」設定: 既定は求めない／保存・解除／プロファイル削除で消える／入力済みはメモリだけ。
// 実行: npx tsx dev-tests/login-password-setting.test.ts
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
const { isLoginPasswordRequired, setLoginPasswordRequired, isLoginUnlocked, markLoginUnlocked } = await import('../src/lib/loginLock');
const { isPurgeKey, purgeAccountData } = await import('../src/lib/accountPurge');

let failed = 0;
function check(name: string, ok: boolean) { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

check('default is not required', !isLoginPasswordRequired('pk1'));
check('not unlocked by default', !isLoginUnlocked('pk1'));
setLoginPasswordRequired('pk1', true);
check('turned on', isLoginPasswordRequired('pk1'));
check('other profile unaffected', !isLoginPasswordRequired('pk2'));
check('purge key of a removed profile', isPurgeKey('kasane.loginPassword.pk1', new Set(), new Set(['pk1'])));
check('purge key of another profile stays', !isPurgeKey('kasane.loginPassword.pk2', new Set(), new Set(['pk1'])));
purgeAccountData([{ id: 'w1', profileKey: 'pk1' }], { profileRemoved: true });
check('setting removed with the profile', !isLoginPasswordRequired('pk1'));
setLoginPasswordRequired('pk2', true);
setLoginPasswordRequired('pk2', false);
check('turned off', !isLoginPasswordRequired('pk2'));
markLoginUnlocked('pk3');
check('unlock is memory only', isLoginUnlocked('pk3') && ![...mem.keys()].some((k) => k.includes('pk3')));
process.exit(failed === 0 ? 0 : 1);
