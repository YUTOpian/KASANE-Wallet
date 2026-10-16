// カスタムテーマを10個まで保存する store（store/appStore.ts）：保存・置き換え・選ぶ・名前を変える・消す・上限、
// 以前の版（1つだけ保存）の引き継ぎ、壊れた保存データの扱い。
// 実行: npx tsx dev-tests/custom-theme-store.test.ts（メモリ上のストレージ、通信なし）
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
const KEY = 'vintage-symbol-wallet-app-store';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

// --- 以前の版：1つだけ保存していた -----------------------------------------------------------------------------------
mem.set(KEY, JSON.stringify({ state: { themeMode: 'custom', customTheme: { name: 'old', root: { accent: '#123456' }, chains: {} } }, version: 3 }));
const mod = await import('../src/store/appStore');
const { useAppStore, selectActiveCustomTheme } = mod;
{
  const s = useAppStore.getState();
  check('the old single theme becomes the first of the list', s.customThemes.length === 1 && s.customThemes[0].name === 'old' && s.customThemes[0].root.accent === '#123456');
  check('... and it is the selected one, still in use', s.customThemeId === s.customThemes[0].id && s.themeMode === 'custom' && selectActiveCustomTheme(s)?.name === 'old');
}

// --- 保存・選ぶ・置き換え ---------------------------------------------------------------------------------------------
const theme = (n: number) => ({ name: `theme ${n}`, root: { accent: '#123456' } as const, chains: {} });
const ids: string[] = [useAppStore.getState().customThemes[0].id];
for (let i = 2; i <= 10; i += 1) {
  const id = useAppStore.getState().saveCustomTheme(theme(i));
  if (id) ids.push(id);
}
{
  const s = useAppStore.getState();
  check('10 themes can be saved', s.customThemes.length === 10 && ids.length === 10 && new Set(ids).size === 10);
  check('a saved theme becomes the selected one', s.customThemeId === ids[9]);
  check('the 11th is refused (null), nothing changes', useAppStore.getState().saveCustomTheme(theme(11)) === null && useAppStore.getState().customThemes.length === 10);
}
{
  const id = useAppStore.getState().saveCustomTheme({ name: 'replaced', root: { accent: '#abcdef' }, chains: {} }, ids[3]);
  const s = useAppStore.getState();
  check('with 10 saved, replacing by id still works', id === ids[3] && s.customThemes.length === 10 && s.customThemes[3].name === 'replaced' && s.customThemes[3].id === ids[3] && s.customThemes[3].root.accent === '#abcdef');
  check('replacing an unknown id counts as a new theme (refused at 10)', useAppStore.getState().saveCustomTheme(theme(12), 'nope') === null);
}
{
  useAppStore.getState().setThemeMode('dark');
  useAppStore.getState().selectCustomTheme(ids[5]);
  const s = useAppStore.getState();
  check('select makes the theme mode "custom" and picks the theme', s.themeMode === 'custom' && s.customThemeId === ids[5] && selectActiveCustomTheme(s)?.id === ids[5]);
  useAppStore.getState().selectCustomTheme('missing');
  check('selecting an unknown id changes nothing', useAppStore.getState().customThemeId === ids[5]);
  useAppStore.getState().renameCustomTheme(ids[5], '  my favourite  ');
  check('rename trims', useAppStore.getState().customThemes[5].name === 'my favourite');
  useAppStore.getState().renameCustomTheme(ids[5], 'x'.repeat(80));
  check('rename caps the length at 40', useAppStore.getState().customThemes[5].name.length === 40);
}

// --- 消す ---------------------------------------------------------------------------------------------------------------
{
  useAppStore.getState().removeCustomTheme(ids[5]);
  const s = useAppStore.getState();
  check('deleting the selected theme: the first remaining one is selected', s.customThemes.length === 9 && s.customThemeId === ids[0] && s.themeMode === 'custom');
  useAppStore.getState().removeCustomTheme(ids[7]);
  check('deleting another theme keeps the selection', useAppStore.getState().customThemeId === ids[0] && useAppStore.getState().customThemes.length === 8);
  check('after a delete there is room again', useAppStore.getState().saveCustomTheme(theme(13)) !== null && useAppStore.getState().customThemes.length === 9);
}

// --- 保存される形 ---------------------------------------------------------------------------------------------------------
{
  const saved = JSON.parse(mem.get(KEY)!);
  check('the list and the selection are persisted', Array.isArray(saved.state.customThemes) && saved.state.customThemes.length === 9 && typeof saved.state.customThemeId === 'string' && !('customTheme' in saved.state));
}
{
  while (useAppStore.getState().customThemes.length > 0) useAppStore.getState().removeCustomTheme(useAppStore.getState().customThemes[0].id);
  const s = useAppStore.getState();
  check('deleting all themes while "custom" is in use goes back to dark', s.customThemes.length === 0 && s.customThemeId === null && s.themeMode === 'dark' && selectActiveCustomTheme(s) === null);
}

// --- 壊れた保存データ ---------------------------------------------------------------------------------------------------------
{
  mem.set(KEY, JSON.stringify({ state: { themeMode: 'custom', customThemes: [{ name: 'bad', root: { bg: 'url(http://evil/x.png)' } }, { id: 'ok1', name: 'ok', root: { accent: '#123456' }, chains: {} }], customThemeId: 'gone' }, version: 3 }));
  const fresh = await import('../src/store/appStore?damaged');
  const s = fresh.useAppStore.getState();
  check('damaged entries are dropped, the rest stay', s.customThemes.length === 1 && s.customThemes[0].id === 'ok1');
  check('a selection that no longer exists falls back to the first theme', s.customThemeId === 'ok1' && s.themeMode === 'custom');
}
{
  mem.set(KEY, JSON.stringify({ state: { themeMode: 'custom', customThemes: 'nonsense' }, version: 3 }));
  const fresh = await import('../src/store/appStore?nonsense');
  const s = fresh.useAppStore.getState();
  check('nonsense: no themes, and "custom" falls back to dark', s.customThemes.length === 0 && s.themeMode === 'dark');
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
