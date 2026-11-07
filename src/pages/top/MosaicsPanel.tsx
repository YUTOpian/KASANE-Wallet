import { useCallback, useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogTitle, Typography } from '@mui/material';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import AccountBalanceWalletOutlinedIcon from '@mui/icons-material/AccountBalanceWalletOutlined';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchChainBalances, nativeAssetId } from '../../lib/chainApi';
import type { MosaicBalance } from '../../lib/symbol/api';
import { useWatchOnly } from '../../hooks/useWatchOnly';
import { useAppStore } from '../../store/appStore';

// 「保有モザイク」: Home の同名リボンを押すと下に展開される、このアカウントが持っているモザイクの一覧。
// ネイティブ通貨（XYM / XEM）は残高0でも先頭に出し、そのほかは残高のあるものだけを出す。
// 横に並べ（最大3列。IDや残高の長さに合わせて列数を減らす。並びきったら次の行へ）、名前（ネームスペース）の下にモザイクID（NEMは名前がIDそのものなので付けない）、各カードに「送る」（そのモザイクが選ばれた状態で送る画面が開く）と「残高表示」（確認でOKを押すと、Home上部の残高カードにそのモザイクを表示する）のボタンがある。
export default function MosaicsPanel({ onShowOnBalanceCard, balanceHidden }: { onShowOnBalanceCard: (id: string) => void; balanceHidden: boolean }) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const liveTick = useAppStore((s) => s.liveTick);
  const setHomePanel = useAppStore((s) => s.setHomePanel);
  const clearReceiverAddress = useAppStore((s) => s.clearReceiverAddress);
  const clearSendDraft = useAppStore((s) => s.clearSendDraft);
  const setSendMosaicId = useAppStore((s) => s.setSendMosaicId);
  // 閲覧用プロファイルには「送る」が無いので、押しても何も起きない。
  const watchOnly = useWatchOnly();
  const [list, setList] = useState<MosaicBalance[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The mosaic whose 「残高表示」 was pressed, waiting for the OK of the confirmation.
  const [confirmMosaic, setConfirmMosaic] = useState<MosaicBalance | null>(null);

  const load = useCallback(async () => {
    try {
      const wallet = await WalletsHelper.getActive();
      if (!wallet) { setList([]); return; }
      const all = await fetchChainBalances(wallet.address);
      setList(all.filter((m) => m.id.toUpperCase() === nativeAssetId().toUpperCase() || m.amount > 0n));
      setFailed(false);
    } catch (e) {
      console.error('Failed to load the mosaics', e);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    setList(null);
    void load();
  }, [load, network, chain]);

  // The node reported something for this account: reload quietly.
  useEffect(() => {
    if (liveTick > 0) void load();
  }, [liveTick, load]);

  if (list === null && !failed) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>;
  }
  if (list === null) {
    return <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_failed')}</Typography>;
  }
  if (list.length === 0) {
    return <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_empty')}</Typography>;
  }

  // Opens 「送る」 as a fresh transfer (like the ribbon does) with this mosaic already chosen ('' = the currency).
  const sendMosaic = (m: MosaicBalance) => {
    clearReceiverAddress();
    clearSendDraft();
    setSendMosaicId(m.id.toUpperCase() === nativeAssetId().toUpperCase() ? '' : m.id);
    setHomePanel('send');
  };
  // The name on top of a card. Symbol: the mosaic's name (its namespace). NEM: the (child) namespace the mosaic belongs to - the part of
  // "namespace:name" before the colon - with the whole id under it; the currency shows its symbol (XEM), like XYM on Symbol.
  const titleOf = (m: MosaicBalance) => {
    if (chain !== 'nem' || m.id.toUpperCase() === nativeAssetId().toUpperCase()) return m.symbol;
    const cut = m.id.lastIndexOf(':');
    return cut > 0 ? m.id.slice(0, cut) : m.id;
  };
  // NEM: the send form only offers mosaics whose definition was read and that may be sent (see loadSendAssets).
  const canSend = (m: MosaicBalance) => {
    if (watchOnly) return false;
    if (chain !== 'nem' || m.id.toUpperCase() === nativeAssetId().toUpperCase()) return true;
    return m.supply !== undefined && m.transferable;
  };

  // 幅が足りない画面（スマホ）では、1列にして、ボタンはカードの中で文字の下の行に回る（右が切れない）。
  // Rough width one card needs: the widest of the name / ID / balance text, the two buttons side by side on its right, padding and gaps.
  const textPx = Math.max(0, ...list.map((m) => Math.max(
    titleOf(m).length * 10,
    m.id.length * 7.5,
    (balanceHidden ? 6 : Number(m.balance).toLocaleString(undefined, { maximumFractionDigits: m.divisibility }).length) * 10,
  )));
  // The text is capped: a long NEM id is cut with an ellipsis rather than pushing the list down to one column (NEM then lays out in 2 columns like Symbol).
  const minCardPx = Math.ceil(Math.min(textPx, 150) + 290 + 40);

  const sideButtonSx = { justifyContent: 'flex-start', textTransform: 'none', whiteSpace: 'nowrap', px: 2, py: 0.75, fontSize: '0.95rem', minWidth: 0 } as const;

  return (
    // The number of columns follows the width of this area (not the window): 2 when narrow, 3 when wider - never more.
    <Box sx={{ containerType: 'inline-size' }}>
      <Box
        sx={{
          display: 'grid',
          // auto-fill (not auto-fit): empty columns are kept, so a single mosaic stays as narrow as one card of a full row. Up to 3 columns; fewer when the longest name / ID / balance (plus the buttons) would not fit a third of the width.
          gridTemplateColumns: `repeat(auto-fill, minmax(max(min(100%, ${minCardPx}px), calc((100% - 24px) / 3)), 1fr))`,
          gap: 1.5,
          p: 2,
          textAlign: 'left',
        }}
      >
        {list.map((m) => (
          <Box key={m.id} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, minWidth: 0, px: 1.25, py: 1.25, border: 1, borderColor: 'divider', borderRadius: 2, textAlign: 'left' }}>
            <Box sx={{ flex: '1 1 150px', minWidth: 0 }}>
              <Typography noWrap title={titleOf(m)} sx={{ fontWeight: 'bold' }}>{titleOf(m)}</Typography>
              {/* The mosaic ID right under the name, on both chains (Symbol: the hex ID, also when the mosaic has no namespace; NEM: the full "namespace:name", e.g. "nem:xem"). */}
              <Typography noWrap variant="caption" title={m.id} sx={{ display: 'block', minHeight: '1.66em', color: 'text.secondary', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
                {m.id}
              </Typography>
              <Typography noWrap sx={{ fontWeight: 'bold', color: 'text.secondary' }}>
                {balanceHidden ? '••••••' : Number(m.balance).toLocaleString(undefined, { maximumFractionDigits: m.divisibility })}
              </Typography>
            </Box>
            {/* 送る / 残高表示: on the right side of the card. */}
            <Box sx={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.75, flex: '1 1 auto' }}>
              {!watchOnly && (
                <Button variant="outlined" size="medium" startIcon={<SendOutlinedIcon />} disabled={!canSend(m)} onClick={() => sendMosaic(m)} sx={sideButtonSx}>
                  {t('home.send')}
                </Button>
              )}
              <Button variant="outlined" size="medium" startIcon={<AccountBalanceWalletOutlinedIcon />} onClick={() => setConfirmMosaic(m)} sx={sideButtonSx}>
                {t('home.balance_show')}
              </Button>
            </Box>
          </Box>
        ))}
      </Box>

      <Dialog open={confirmMosaic !== null} onClose={() => setConfirmMosaic(null)}>
        <DialogTitle>{t('home.balance_show_confirm')}</DialogTitle>
        <DialogActions>
          <Button onClick={() => setConfirmMosaic(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (confirmMosaic) onShowOnBalanceCard(confirmMosaic.id.toUpperCase() === nativeAssetId().toUpperCase() ? '' : confirmMosaic.id);
              setConfirmMosaic(null);
            }}
          >
            {t('common.ok')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
