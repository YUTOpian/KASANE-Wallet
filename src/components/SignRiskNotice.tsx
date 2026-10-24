import { useMemo } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAddressBook, useOwnAddresses } from '../hooks/useAddressBook';
import { useAppStore } from '../store/appStore';
import { trustOf } from '../lib/addressBook';
import { analyzeSignRisks } from '../lib/signRisk';
import type { SignRisk } from '../lib/signRisk';
import type { PartialItem } from '../lib/symbol/multisigApi';
import { parseWatchAddress } from '../lib/watchAddress';

const SEVERITY = { danger: 'error', warning: 'warning', info: 'info' } as const;

/** 危険警告を1件ずつ並べる（重いものが先）。 */
function RiskList({ risks }: { risks: readonly SignRisk[] }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {risks.map((r) => (
        <Alert key={`${r.code}|${JSON.stringify(r.params ?? {})}`} severity={SEVERITY[r.level]}>{t(`signrisk.${r.code}`, r.params)}</Alert>
      ))}
    </Box>
  );
}

/**
 * 署名依頼の中身の危険警告（送金先や連署者に追加されるアドレスが要注意／アドレス帳にない、設定の変更、読み取れない内容など）。
 * 依頼を送ってきた人（作成者）の警告は SignerTrustNotice が出す。何もなければ何も出さない。
 */
export default function SignRiskNotice({ items, sx }: { items: readonly PartialItem[]; sx?: object }) {
  const chain = useAppStore((s) => s.chain);
  const network = useAppStore((s) => s.network);
  const { entries, loaded } = useAddressBook();
  const own = useOwnAddresses();
  const risks = useMemo(() => {
    if (!loaded) return [];
    return analyzeSignRisks(items, (address) => {
      const parsed = parseWatchAddress(address);
      return parsed ? trustOf(entries, chain, network, parsed.address, own).trust : 'unknown';
    });
  }, [items, entries, chain, network, own, loaded]);
  if (risks.length === 0) return null;
  return <Box sx={sx}><RiskList risks={risks} /></Box>;
}

/** 署名に進む前の最後の確認（要注意のアドレスが関わる依頼）。 */
export function SignRiskDialog({ risks, onCancel, onContinue }: { risks: readonly SignRisk[] | null; onCancel: () => void; onContinue: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={risks !== null} onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle>{t('signrisk.dialog_title')}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 1.5 }}>{t('signrisk.dialog_message')}</DialogContentText>
        {risks && <RiskList risks={risks} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} autoFocus>{t('common.cancel')}</Button>
        <Button color="error" onClick={onContinue}>{t('signrisk.dialog_continue')}</Button>
      </DialogActions>
    </Dialog>
  );
}

