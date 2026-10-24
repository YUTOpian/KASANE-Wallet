import { useEffect, useState } from 'react';
import { Alert, Button, Snackbar } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/appStore';
import { WalletsHelper } from '../lib/storage';
import { fetchOwnedNamespaces } from '../lib/symbol/api';
import { expiringRoots, remainingDays } from '../lib/symbol/namespaceRenew';
import { useNoKey } from '../hooks/useWatchOnly';
import SwipeDismiss from './SwipeDismiss';

// NEM の「ネームスペースの期限」の警告（NemNamespaceExpiryNotice）の Symbol 版：ルートネームスペースの期限が1か月以内になったら、
// ネームスペースごとに1回だけ（10秒）、警告のトーストを出す。「更新」タブへのボタン付き。
// 1つのウォレット・ネットワークにつき、アプリを開いているあいだに一度だけ調べる。
const checked = new Set<string>();
const alerted = new Set<string>();

interface Notice { key: string; name: string; days: number }

export default function SymbolNamespaceExpiryNotice() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  // 閲覧用プロファイルは更新できないので、警告も出さない。
  const noKey = useNoKey();
  const [queue, setQueue] = useState<Notice[]>([]);

  useEffect(() => {
    if (chain !== 'symbol' || noKey) return undefined;
    let cancelled = false;
    (async () => {
      const wallet = await WalletsHelper.getActive();
      if (!wallet || cancelled) return;
      const walletKey = `${network}:${wallet.address}`;
      if (checked.has(walletKey)) return;
      checked.add(walletKey);
      try {
        const nowMs = Date.now();
        const roots = expiringRoots(await fetchOwnedNamespaces(wallet.address), nowMs);
        if (cancelled) { checked.delete(walletKey); return; }
        const fresh = roots
          .filter((r) => !alerted.has(`${walletKey}:${r.name}`))
          .map((r) => ({ key: `${walletKey}:${r.name}`, name: r.name, days: remainingDays(r, nowMs) ?? 0 }));
        fresh.forEach((n) => alerted.add(n.key));
        if (fresh.length > 0) setQueue((q) => [...q, ...fresh]);
      } catch {
        checked.delete(walletKey); // try again on the next screen
      }
    })();
    return () => { cancelled = true; };
  }, [chain, network, pathname, noKey]);

  const current = queue[0];
  const next = () => setQueue((q) => q.slice(1));

  return (
    <Snackbar key={current?.key} open={current !== undefined} autoHideDuration={10000} onClose={(_, reason) => { if (reason !== 'clickaway') next(); }} anchorOrigin={{ vertical: 'top', horizontal: 'right' }}>
      <SwipeDismiss onDismiss={next}>
      <Alert
        severity="warning"
        onClose={next}
        action={<Button color="inherit" size="small" onClick={() => { next(); navigate('/namespace/renew'); }}>{t('namespace.renew_alert_link')}</Button>}
        sx={{ width: '100%' }}
      >
        {t('namespace.renew_alert_message', { name: current?.name ?? '', days: current?.days ?? 0 })}
      </Alert>
      </SwipeDismiss>
    </Snackbar>
  );
}
