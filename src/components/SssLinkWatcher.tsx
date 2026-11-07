import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Snackbar } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../lib/storage';
import { isSssAutoAdd, SSS_NETWORK_MISMATCH_EVENT } from '../lib/sss';
import { sssFollow } from '../lib/sssFollow';
import { NETWORKS } from '../lib/symbol/constants';
import type { SymbolNetwork } from '../lib/symbol/constants';
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

const SETTLE_MS = 1500;

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
  // 再読み込みを促す知らせ（出す文言のキー。null = 出さない）。
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  // SSS に合わせてアプリのネットワークを切り替えたとき、その知らせ（SSS のプロファイル以外のとき）。
  const [followed, setFollowed] = useState<SymbolNetwork | null>(null);
  const prevSssNetwork = useRef<string | null>(null);
  const sssNetwork = account?.network ?? null;
  const appNetwork = useAppStore((s) => s.network);
  const appChain = useAppStore((s) => s.chain);

  // 使っているのが SSS のプロファイルなら、チェーン・ネットワークは常に SSS に合わせる（SSS は Symbol のみで、
  // メインネットかテストネットかは SSS で決まる）。SSS で切り替えると、アプリも追いかける。
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    WalletsHelper.getActiveAny().then((w) => {
      if (cancelled || !w?.sss) return;
      const st = useAppStore.getState();
      const r = sssFollow({ sssNetwork: account.network, appNetwork: st.network, appChain: st.chain, profile: w, sssNetworkJustChanged: false });
      if (r.network) st.setNetwork(r.network);
      if (r.switchChainToSymbol) st.setChain('symbol');
    }).catch((e) => console.error('SssLinkWatcher: failed to follow the SSS network', e));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, networkType, appNetwork, appChain]);

  // SSS のプロファイル以外（ニーモニックなど）を使っているときも、SSS のネットワークが分かった・切り替わったそのときに、
  // 食い違っていればアプリを SSS に合わせる。そのあとで手動で切り替えた分は戻さない（判定は lib/sssFollow.ts）。
  // 閲覧用プロファイル・NEM・mijin v2 は合わせない。
  // 署名のとき SSS とアプリのネットワークが違っていたら、再読み込みを促す（lib/sss.ts の signWithSss が知らせる）。
  useEffect(() => {
    const onMismatch = (e: Event) => setReloadNotice((e as CustomEvent).detail === 'signature' ? 'sss.sign_signature_mismatch' : 'sss.sign_network_mismatch');
    window.addEventListener(SSS_NETWORK_MISMATCH_EVENT, onMismatch);
    return () => window.removeEventListener(SSS_NETWORK_MISMATCH_EVENT, onMismatch);
  }, []);

  const followedSss = useRef<string | null>(null);
  useEffect(() => {
    if (sssNetwork === null || followedSss.current === sssNetwork) return;
    followedSss.current = sssNetwork;
    WalletsHelper.getActiveAny().then((w) => {
      const st = useAppStore.getState();
      const r = sssFollow({ sssNetwork, appNetwork: st.network, appChain: st.chain, profile: w, sssNetworkJustChanged: true });
      if (!w?.sss && r.network) {
        st.setNetwork(r.network);
        setFollowed(r.network);
      }
    }).catch((e) => console.error('SssLinkWatcher: failed to follow the SSS network', e));
  }, [sssNetwork]);

  // 使っているのが SSS のプロファイルで、開いている間に SSS のネットワークが切り替わったら、再読み込みを促す。
  // （アプリは追いかけて切り替えるが、読み込み済みの表示や通信を確実にそろえるには、再読み込みが確実）
  useEffect(() => {
    if (sssNetwork === null) return;
    const prev = prevSssNetwork.current;
    prevSssNetwork.current = sssNetwork;
    if (prev === null || prev === sssNetwork) return;
    let cancelled = false;
    WalletsHelper.getActiveAny().then((w) => { if (!cancelled && w?.sss) setReloadNotice('sss.network_changed'); })
      .catch((e) => console.error('SssLinkWatcher: failed to check the active profile', e));
    return () => { cancelled = true; };
  }, [sssNetwork]);

  // SSS で選んだアカウントがまだプロファイルに無ければ追加する流れ。
  // - SSS でネットワークを切り替えると、SSS のアカウントが別のネットワークのものに変わる。これは「新しいアカウントを足した」のではないので、
  //   プロファイルは作らず、聞きもしない（切り替わったところを、安定した値どうしの比べで見つける）。
  // - 切り替えの途中（公開鍵とネットワークが別々のタイミングで変わる）の値は、数えない。値が落ち着いて 1.5 秒たってから確かめる。
  const stableNetwork = useRef<number | null>(null);
  useEffect(() => {
    if (!account) return;
    const acc = account;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const prevNet = stableNetwork.current;
      stableNetwork.current = acc.networkType;
      if (prevNet !== null && prevNet !== acc.networkType) { handled.current.add(acc.publicKey); setNotice(null); return; }
      if (handled.current.has(acc.publicKey) || quietRoute()) return;
      (async () => {
        const wallets = await WalletsHelper.gets();
        if (cancelled || wallets.length === 0) return; // プロファイルがまだ無い：新規作成の流れに任せる
        if (wallets.some((w) => w.sss && w.publicKey.toUpperCase() === acc.publicKey)) {
          handled.current.add(acc.publicKey);
          return;
        }
        if (isSssAutoAdd()) {
          handled.current.add(acc.publicKey);
          await WalletsHelper.addSssProfile(acc.name || t('sss.default_name'), acc.publicKey, false);
          if (!cancelled) setNotice({ kind: 'added', account: acc });
          return;
        }
        setNotice({ kind: 'ask', account: acc });
      })().catch((e) => console.error('SssLinkWatcher: failed to check the SSS account', e));
    }, SETTLE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
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
    <Snackbar open={reloadNotice !== null} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
      <Alert severity="info" onClose={() => setReloadNotice(null)} sx={{ width: '100%', alignItems: 'center' }}
        action={<Button color="inherit" size="small" sx={{ fontWeight: 700 }} onClick={() => window.location.reload()}>{t('sss.reload')}</Button>}>
        {reloadNotice ? t(reloadNotice) : ''}
      </Alert>
    </Snackbar>
    <Snackbar open={followed !== null} autoHideDuration={6000} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      onClose={(_, reason) => { if (reason !== 'clickaway') setFollowed(null); }}>
      <Alert severity="info" onClose={() => setFollowed(null)} sx={{ width: '100%', alignItems: 'center' }}>
        {t('sss.network_followed', { network: followed ? NETWORKS[followed].label : '' })}
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
