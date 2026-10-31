import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Snackbar } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../lib/storage';
import { isSssAutoAdd } from '../lib/sss';
import type { SssAccount } from '../lib/sss';
import { useSssAccount } from '../hooks/useSssAccount';
import { useAppStore } from '../store/appStore';
import SwipeDismiss from './SwipeDismiss';

// SSS Extension と連携できているとき、SSS で選んだアカウントがまだプロファイルに無ければ、その場で追加できるようにする。
// 「連携できているとき」= SSS が入っていて、このページが許可されているとき。アカウントを切り替えるたびに確かめ直す。
// 出さない場面：はじめて開く流れ（ウェルカム・作成・読み込み。プロファイルが1つも無いうちを含む）。
// 「確認せず自動で追加」がオンなら、聞かずに追加して知らせるだけ（使うアカウントは切り替えない）。
function quietRoute(): boolean {
  const path = window.location.hash.replace(/^#/, '').split('?')[0];
  if (path === '' || path === '/' || path === '/welcome') return true;
  return path.startsWith('/wallet/') && path !== '/wallet/select';
}

type Notice = { kind: 'ask' | 'added'; account: SssAccount; added?: boolean };

export default function SssLinkWatcher() {
  const { t } = useTranslation();
  const setAppChain = useAppStore((s) => s.setChain);
  const setAppNetwork = useAppStore((s) => s.setNetwork);
  const { account } = useSssAccount();
  const [notice, setNotice] = useState<Notice | null>(null);
  // このブラウザを開いている間、聞いたアカウント（追加した・「今はしない」にした）。同じものを何度も聞かない。
  const handled = useRef<Set<string>>(new Set());
  const publicKey = account?.publicKey ?? '';
  const networkType = account?.networkType ?? 0;
  const [reloadNotice, setReloadNotice] = useState(false);
  const prevSssNetwork = useRef<string | null>(null);
  const sssNetwork = account?.network ?? null;
  const appNetwork = useAppStore((s) => s.network);
  const appChain = useAppStore((s) => s.chain);

  // 使っているのが SSS のプロファイルなら、チェーン・ネットワークは SSS に合わせる（SSS は Symbol のみで、
  // メインネットかテストネットかは SSS で決まる）。SSS で切り替えると、アプリも追いかける。
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    WalletsHelper.getActiveAny().then((w) => {
      if (cancelled || !w?.sss) return;
      const st = useAppStore.getState();
      if (st.network !== account.network) st.setNetwork(account.network);
      if (st.chain !== 'symbol') st.setChain('symbol');
    }).catch((e) => console.error('SssLinkWatcher: failed to follow the SSS network', e));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, networkType, appNetwork, appChain]);

  // 使っているのが SSS のプロファイルで、開いている間に SSS のネットワークが切り替わったら、再読み込みを促す。
  // （アプリは追いかけて切り替えるが、読み込み済みの表示や通信を確実にそろえるには、再読み込みが確実）
  useEffect(() => {
    if (sssNetwork === null) return;
    const prev = prevSssNetwork.current;
    prevSssNetwork.current = sssNetwork;
    if (prev === null || prev === sssNetwork) return;
    let cancelled = false;
    WalletsHelper.getActiveAny().then((w) => { if (!cancelled && w?.sss) setReloadNotice(true); })
      .catch((e) => console.error('SssLinkWatcher: failed to check the active profile', e));
    return () => { cancelled = true; };
  }, [sssNetwork]);

  useEffect(() => {
    if (!account || handled.current.has(account.publicKey) || quietRoute()) return;
    let cancelled = false;
    (async () => {
      const wallets = await WalletsHelper.gets();
      if (cancelled || wallets.length === 0) return; // プロファイルがまだ無い：新規作成の流れに任せる
      if (wallets.some((w) => w.sss && w.publicKey.toUpperCase() === account.publicKey)) {
        handled.current.add(account.publicKey);
        return;
      }
      if (isSssAutoAdd()) {
        handled.current.add(account.publicKey);
        await WalletsHelper.addSssProfile(account.name || t('sss.default_name'), account.publicKey, false);
        if (!cancelled) setNotice({ kind: 'added', account });
        return;
      }
      setNotice({ kind: 'ask', account });
    })().catch((e) => console.error('SssLinkWatcher: failed to check the SSS account', e));
    return () => { cancelled = true; };
    // account の中身（公開鍵・ネットワーク）が変わったときだけ確かめ直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, networkType]);

  const close = () => setNotice(null);
  const skip = () => { if (notice) handled.current.add(notice.account.publicKey); close(); };
  // 追加して、そのアカウントを使う。
  const add = async (n: Notice, activate: boolean) => {
    handled.current.add(n.account.publicKey);
    try {
      await WalletsHelper.addSssProfile(n.account.name || t('sss.default_name'), n.account.publicKey, activate);
      if (activate) {
        setAppChain('symbol');
        setAppNetwork(n.account.network);
        window.location.hash = '#/top';
      }
    } catch (e) {
      console.error('SssLinkWatcher: failed to add the SSS profile', e);
    }
    close();
  };

  const label = notice ? (notice.account.name || notice.account.address.slice(0, 8) + '…') : '';
  return (
    <>
    <Snackbar open={reloadNotice} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
      <Alert severity="info" onClose={() => setReloadNotice(false)} sx={{ width: '100%', alignItems: 'center' }}
        action={<Button color="inherit" size="small" sx={{ fontWeight: 700 }} onClick={() => window.location.reload()}>{t('sss.reload')}</Button>}>
        {t('sss.network_changed')}
      </Alert>
    </Snackbar>
    <Snackbar open={notice !== null} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} autoHideDuration={notice?.kind === 'added' ? 8000 : null} onClose={(_, reason) => { if (reason !== 'clickaway') close(); }}>
      <SwipeDismiss onDismiss={notice?.kind === 'ask' ? skip : close}>
        {notice?.kind === 'ask' ? (
          <Alert severity="info" sx={{ width: '100%', alignItems: 'center' }}
            action={<>
              <Button color="inherit" size="small" onClick={skip}>{t('sss.notice_skip')}</Button>
              <Button color="inherit" size="small" sx={{ fontWeight: 700 }} onClick={() => void add(notice, true)}>{t('sss.notice_add')}</Button>
            </>}>
            {t('sss.notice_detected', { name: label })}
          </Alert>
        ) : (
          <Alert severity="success" onClose={close} sx={{ width: '100%', alignItems: 'center' }}
            action={notice ? <Button color="inherit" size="small" sx={{ fontWeight: 700 }} onClick={() => void add(notice, true)}>{t('sss.notice_switch')}</Button> : undefined}>
            {t('sss.notice_added', { name: label })}
          </Alert>
        )}
      </SwipeDismiss>
    </Snackbar>
    </>
  );
}
