import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Checkbox, Chip, CircularProgress, Tab, Tabs, Typography, alpha } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import KasaneStage from '../../components/kasane/KasaneStage';
import { getPendingImport, setPendingShownIndexes } from '../../lib/pendingImport';
import type { ShownIndexes } from '../../lib/pendingImport';
import { deriveAddresses, scanAccounts } from '../../lib/importScan';
import type { ScannedAccount } from '../../lib/importScan';
import { CHAIN_ORDER, chainMeta } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';

type PerChain<T> = Record<ChainKey, T>;

// Second step of importing a recovery phrase: the addresses derived from it (index 0..9, for Symbol and for NEM)
// are looked up on the network, the ones in use are ticked, and the person picks which accounts to show.
// Only public data (address / balance) is looked up. Nothing is forced: if no account is ticked, index 0 is used.
export default function WalletLoginAccounts() {
  const navigate = useNavigate();
  const pending = getPendingImport();

  // The phrase only lives in memory: after a reload (or when opened directly) start over at the import screen.
  useEffect(() => {
    if (!pending) navigate('/wallet/login/import', { replace: true });
  }, [pending, navigate]);

  if (!pending) return null;
  return (
    <AccountSelectView
      phrase={pending.phrase}
      chain={pending.chain}
      initialShown={pending.shownIndexes}
      back="/wallet/login/import"
      onNext={(indexes) => {
        setPendingShownIndexes(indexes);
        navigate('/wallet/login/name');
      }}
    />
  );
}

export interface AccountSelectViewProps {
  phrase: string;
  chain: ChainKey;
  initialShown: ShownIndexes;
  /** 戻るボタン・矢印の行き先。 */
  back: string;
  /** 「次へ」。選んだインデックス（何も選ばなければ 0）が渡される。 */
  onNext: (indexes: ShownIndexes) => void;
  /** true の間は「次へ」を押せない（保存中など）。 */
  busy?: boolean;
  nextLabel?: string;
}

// 取り込み（ニーモニック入力後）と新規作成（ニーモニック確認後）で共有する「アカウントの選択」画面。
export function AccountSelectView({ phrase, chain: initialChain, initialShown, back, onNext, busy = false, nextLabel }: AccountSelectViewProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const initial = useMemo<PerChain<ScannedAccount[]>>(
    () => ({ symbol: deriveAddresses(phrase, 'symbol'), nem: deriveAddresses(phrase, 'nem') }),
    [phrase],
  );
  const [tab, setTab] = useState<ChainKey>(initialChain);
  const [rows, setRows] = useState<PerChain<ScannedAccount[]>>(initial);
  const [scanning, setScanning] = useState<PerChain<boolean>>({ symbol: true, nem: true });
  const [selected, setSelected] = useState<PerChain<Set<number>>>(() => ({
    symbol: new Set(initialShown.symbol),
    nem: new Set(initialShown.nem),
  }));
  // Rows the person ticked / unticked by hand are not changed by a late scan result.
  const touched = useRef<PerChain<Set<number>>>({ symbol: new Set(), nem: new Set() });

  useEffect(() => {
    let stopped = false;
    for (const chain of CHAIN_ORDER) {
      setScanning((prev) => ({ ...prev, [chain]: true }));
      void scanAccounts(
        initial[chain],
        chain,
        (row) => {
          if (stopped) return;
          setRows((prev) => ({ ...prev, [chain]: prev[chain].map((r) => (r.index === row.index ? row : r)) }));
          if (row.active && !touched.current[chain].has(row.index)) {
            setSelected((prev) => ({ ...prev, [chain]: new Set(prev[chain]).add(row.index) }));
          }
        },
        () => stopped,
      ).finally(() => { if (!stopped) setScanning((prev) => ({ ...prev, [chain]: false })); });
    }
    return () => { stopped = true; };
  }, [initial]);

  const toggle = (chain: ChainKey, index: number) => {
    touched.current[chain].add(index);
    setSelected((prev) => {
      const next = new Set(prev[chain]);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...prev, [chain]: next };
    });
  };

  const next = () => {
    // 何も選ばなかったチェーンは、自動的にインデックス0を選んだことにする。
    const pick = (chain: ChainKey) => (selected[chain].size > 0 ? [...selected[chain]] : [0]);
    onNext({ symbol: pick('symbol'), nem: pick('nem') });
  };

  const setAll = (chain: ChainKey, mode: 'all' | 'used' | 'none') => {
    for (const r of rows[chain]) touched.current[chain].add(r.index);
    setSelected((prev) => ({
      ...prev,
      [chain]: new Set(
        rows[chain]
          .filter((r) => mode === 'all' || (mode === 'used' && r.active))
          .map((r) => r.index),
      ),
    }));
  };

  const symbol = chainMeta(tab).currencySymbol;
  const failed = !scanning[tab] && rows[tab].some((r) => r.active === null);
  const total = rows[tab].length;
  // Two columns on wide screens, filled top to bottom (0-4 on the left, 5-9 on the right).
  const gridRows = Math.ceil(total / 2);

  return (
    <KasaneStage back={back} title={t('wallet.login_accounts_title')} maxWidth={1040}>
      <Box sx={{ width: '100%', flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Typography align="center" color="text.secondary" sx={{ mx: 'auto', maxWidth: 720, lineHeight: 1.9 }}>
          {(t('wallet.login_accounts_message', { returnObjects: true }) as string[]).join('')}
        </Typography>

        <Tabs value={tab} onChange={(_, v: ChainKey) => setTab(v)} centered sx={{ mt: 2 }}>
          {CHAIN_ORDER.map((chain) => (
            <Tab
              key={chain}
              value={chain}
              sx={{ minWidth: 200 }}
              label={chainMeta(chain).name}
            />
          ))}
        </Tabs>

        <Box
          sx={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
            columnGap: 2, rowGap: 0.5, mt: 2, mb: 1.5, px: 0.5, minHeight: 36,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {scanning[tab] && <CircularProgress size={16} />}
            <Typography variant="body2" color="text.secondary">
              {scanning[tab] ? t('wallet.login_accounts_scanning') : failed ? t('wallet.login_accounts_partial') : t('wallet.login_accounts_done')}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ mr: 1 }}>
              {t('wallet.login_accounts_selected', { count: selected[tab].size, total })}
            </Typography>
            <Button size="small" onClick={() => setAll(tab, 'used')} disabled={scanning[tab]}>{t('wallet.login_accounts_select_used')}</Button>
            <Button size="small" onClick={() => setAll(tab, 'all')}>{t('wallet.login_accounts_select_all')}</Button>
            <Button size="small" onClick={() => setAll(tab, 'none')}>{t('wallet.login_accounts_clear')}</Button>
          </Box>
        </Box>

        <Box
          component="ul"
          sx={{
            listStyle: 'none', p: 0, m: 0,
            display: 'grid', gap: 1.5,
            gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
            gridTemplateRows: { md: `repeat(${gridRows}, auto)` },
            gridAutoFlow: { md: 'column' },
          }}
        >
          {rows[tab].map((row) => {
            const checked = selected[tab].has(row.index);
            return (
              <Box component="li" key={row.index} sx={{ display: 'flex' }}>
                <Box
                  component="label"
                  sx={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1.25,
                    border: 1, borderRadius: 2, boxSizing: 'border-box',
                    borderColor: checked ? 'primary.main' : 'divider',
                    bgcolor: (th) => (checked ? alpha(th.palette.primary.main, 0.1) : alpha(th.palette.mode === 'dark' ? th.palette.common.white : th.palette.common.black, 0.04)),
                    cursor: 'pointer',
                    transition: 'background-color .15s, border-color .15s',
                    '&:hover': { borderColor: 'primary.main' },
                  }}
                >
                  <Checkbox
                    checked={checked}
                    onChange={() => toggle(tab, row.index)}
                    slotProps={{ input: { 'aria-label': t('wallet.login_accounts_row', { index: row.index }) } }}
                  />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography sx={{ fontWeight: 600, fontSize: 15 }}>
                          {t('wallet.login_accounts_row', { index: row.index })}
                        </Typography>
                        {row.active && (
                          <Chip size="small" color="primary" variant="outlined" label={t('wallet.login_accounts_used')} sx={{ height: 20, fontSize: 11 }} />
                        )}
                      </Box>
                      <Typography sx={{ fontSize: 15, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', opacity: row.balance === null ? 0.5 : 1 }}>
                        {row.balance === null ? (scanning[tab] ? '…' : '—') : `${row.balance} ${symbol}`}
                      </Typography>
                    </Box>
                    <Typography color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 13, mt: 0.25, wordBreak: 'break-all' }}>
                      {row.prettyAddress}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>

        <Typography variant="caption" color="text.secondary" component="p" align="center" sx={{ mt: 2 }}>
          {t('wallet.login_accounts_note')}
        </Typography>

        <Box sx={{ flexGrow: 1 }} />

        <Box
          sx={{
            // デスクトップでは帯をやめて、ボタンだけを中央に揃える。スマホは一覧が長いので下に固定する。
            position: { xs: 'sticky', md: 'static' }, bottom: 0, zIndex: 1, mt: { xs: 2, md: 4 }, pb: { xs: 1.5, md: 1 }, pt: { xs: 1.5, md: 0 },
            mx: { xs: -2, md: 0 }, px: { xs: 2, md: 0 },
            display: 'flex', justifyContent: 'center', gap: 2,
            backdropFilter: { xs: 'blur(12px)', md: 'none' },
            bgcolor: (th) => ({ xs: alpha(th.palette.mode === 'dark' ? th.palette.common.black : th.palette.common.white, th.palette.mode === 'dark' ? 0.25 : 0.6), md: 'transparent' }),
            borderTop: { xs: 1, md: 0 }, borderColor: 'divider',
          }}
        >
          <Button variant="outlined" disabled={busy} onClick={() => navigate(back)} sx={{ minWidth: 160 }}>{t('wallet.login_accounts_back')}</Button>
          <Button variant="contained" color="primary" disabled={busy} onClick={next} sx={{ minWidth: 160 }}>{nextLabel ?? t('wallet.login_accounts_next')}</Button>
        </Box>
      </Box>
    </KasaneStage>
  );
}
