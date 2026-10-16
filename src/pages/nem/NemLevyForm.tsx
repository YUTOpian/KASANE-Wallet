import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, FormControlLabel, InputAdornment, Radio, RadioGroup, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { fetchNemMosaicInfos } from '../../lib/nem/api';
import type { NemMosaicInfo } from '../../lib/nem/api';
import { normalizeNemAddress } from '../../lib/nem/crypto';
import { NEM_MAX_LEVY_FEE, NEM_MAX_LEVY_PERCENTILE, validateNemLevy } from '../../lib/nem/mosaicEdit';
import type { NemLevyError } from '../../lib/nem/mosaicEdit';
import { splitNemMosaicId } from '../../lib/nem/tx';
import type { NemMosaicLevyParams } from '../../lib/nem/tx';
import { groupDigits } from '../mosaic/mosaicFlags';
import { FormRow, SectionHead, fixedAtomic } from './mosaicLayout';

type LevyCheck = { state: 'idle' } | { state: 'loading' } | { state: 'found'; info: NemMosaicInfo } | { state: 'missing' };

/** The levy part of the mosaic creation form: its state, the value to send, and whether it lets the form go on. */
export function useNemLevyForm(networkByte: number, network: string) {
  const [enabled, setEnabled] = useState(false);
  const [feeType, setFeeType] = useState<'absolute' | 'percentile'>('absolute');
  const [recipient, setRecipient] = useState('');
  const [mosaic, setMosaic] = useState('nem:xem');
  const [feeText, setFeeText] = useState('');
  const [check, setCheck] = useState<LevyCheck>({ state: 'idle' });

  const mosaicId = mosaic.trim().toLowerCase();
  const mosaicShapeOk = (() => { try { splitNemMosaicId(mosaicId); return true; } catch { return false; } })();

  // The mosaic a levy is paid in has to exist: look it up while the levy is being set.
  useEffect(() => {
    if (!enabled || !mosaicShapeOk) { setCheck({ state: 'idle' }); return undefined; }
    let cancelled = false;
    setCheck({ state: 'loading' });
    const timer = setTimeout(async () => {
      const infos = await fetchNemMosaicInfos([mosaicId]);
      if (cancelled) return;
      const info = infos[mosaicId];
      setCheck(info ? { state: 'found', info } : { state: 'missing' });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, mosaicId, mosaicShapeOk, network]);

  const fee = /^\d+$/.test(feeText) ? BigInt(feeText) : 0n;
  const value: NemMosaicLevyParams | null = enabled
    ? { feeType, recipient: normalizeNemAddress(recipient), mosaicId, fee }
    : null;
  const error = value ? validateNemLevy(value, networkByte) : null;
  const missing = enabled && mosaicShapeOk && check.state === 'missing';
  const pending = enabled && (check.state === 'loading' || (mosaicShapeOk && check.state === 'idle'));
  // Switched on: the recipient, the mosaic and the amount all have to be filled in properly before the form goes on.
  const ok = !enabled || (value !== null && error === null && mosaicShapeOk && !missing && !pending && feeText !== '');

  return { enabled, setEnabled, feeType, setFeeType, recipient, setRecipient, mosaic, setMosaic, feeText, setFeeText, check, mosaicId, mosaicShapeOk, fee, value, error, missing, ok };
}

export type NemLevyForm = ReturnType<typeof useNemLevyForm>;

export interface NemLevyFieldsProps {
  mosaic: string;
  setMosaic: (v: string) => void;
  mosaicShapeOk: boolean;
  missing: boolean;
  checking: boolean;
  /** Divisibility of the levy mosaic once it was found (to show the amount with its decimals). */
  feeHintDiv: number | null;
  recipient: string;
  setRecipient: (v: string) => void;
  feeType: 'absolute' | 'percentile';
  setFeeType: (v: 'absolute' | 'percentile') => void;
  feeText: string;
  setFeeText: (v: string) => void;
  fee: bigint;
  mosaicId: string;
  error: NemLevyError | null;
  /** The mosaic that carries the levy ("namespace:name"), used in the percentile examples. */
  sentMosaic: string;
  /** Symbol-style layout (outlined fields with their label inside, one column) instead of NanoWallet's label-on-the-left rows. */
  stacked?: boolean;
}

/** The fields of a levy, laid out like NanoWallet's 「徴収」 block (label on the left, field on the right) or, with `stacked`, like Symbol's forms; a note box at the end. */
export function NemLevyFieldsBox(p: NemLevyFieldsProps) {
  const { t } = useTranslation();
  const stacked = p.stacked === true;
  // Standard (underlined) fields sit in a label row; stacked ones are outlined with the label inside the field.
  const fieldProps = (label: string) => (stacked ? { label, sx: { mb: 2 } } : { variant: 'standard' as const });
  const row = (label: string, node: ReactNode, top = false) => (stacked ? <Box key={label}>{node}</Box> : <FormRow label={label} top={top}>{node}</FormRow>);
  const errorText = p.error === 'recipient' ? t('nemmosaic.edit_levy_invalid_recipient')
    : p.error === 'fee' ? (p.feeType === 'percentile'
      ? t('nemmosaic.edit_levy_invalid_fee_percentile', { max: groupDigits(NEM_MAX_LEVY_PERCENTILE.toString()) })
      : t('nemmosaic.edit_levy_invalid_fee', { max: groupDigits(NEM_MAX_LEVY_FEE.toString()) }))
    : '';
  const feeError = p.error === 'fee' && p.feeText !== '';
  // The levy mosaic's decimals: nem:xem is known; another one once it was found (until then the amounts are shown as they are).
  const levyDiv = p.mosaicId === 'nem:xem' ? 6 : p.feeHintDiv;
  const levyAmount = (atomic: bigint) => (levyDiv === null ? atomic.toString() : fixedAtomic(atomic, levyDiv));
  // NIS1: a percentile levy is floor(amount sent × rate / 10,000) in the smallest unit of the levy mosaic.
  const examples = [100n, 1000n, 3145n, 10000n, 0n];

  return (
    <>
      {row(t('nemmosaic.levy_mosaic_pick'), (
        <TextField
          {...fieldProps(t('nemmosaic.levy_mosaic_pick'))}
          value={p.mosaic}
          onChange={(e) => p.setMosaic(e.target.value.toLowerCase().replace(/[^a-z0-9_.:-]/g, ''))}
          error={p.mosaic !== '' && (!p.mosaicShapeOk || p.missing)}
          helperText={
            p.mosaic !== '' && !p.mosaicShapeOk ? t('nemmosaic.edit_levy_invalid_mosaic')
              : p.missing ? t('nemmosaic.edit_levy_mosaic_missing')
                : p.checking ? t('nemmosaic.edit_levy_checking')
                  : t('nemmosaic.edit_levy_mosaic_hint')
          }
          fullWidth
          slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } }}
        />
      ))}
      {row(t('nemmosaic.levy_recipient_short'), (
        <TextField
          {...fieldProps(t('nemmosaic.levy_recipient_short'))}
          value={p.recipient}
          onChange={(e) => p.setRecipient(e.target.value.toUpperCase().replace(/[^A-Z2-7-]/g, ''))}
          error={p.error === 'recipient'}
          helperText={p.error === 'recipient' ? errorText : t('nemmosaic.edit_levy_recipient_hint')}
          fullWidth
          slotProps={{ htmlInput: { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false, style: { fontFamily: 'monospace', fontSize: 13 } } }}
        />
      ))}
      {row(t('nemmosaic.levy_fee_short'), (
        <TextField
          {...fieldProps(t('nemmosaic.levy_fee_short'))}
          value={p.feeText}
          onChange={(e) => p.setFeeText(e.target.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, ''))}
          error={feeError}
          helperText={feeError ? errorText : undefined}
          fullWidth
          slotProps={{
            htmlInput: { inputMode: 'numeric' },
            input: { endAdornment: <InputAdornment position="end"><Typography sx={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'text.secondary' }}>{p.feeType === 'percentile' ? '/ 10,000' : `${p.mosaicId} (μ)`}</Typography></InputAdornment> },
          }}
        />
      ))}
      {stacked ? (
        <>
          <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('nemmosaic.levy_type_short')}</Typography>
          <ToggleButtonGroup exclusive fullWidth size="small" color="primary" value={p.feeType} sx={{ mb: 2 }} onChange={(_, v: 'absolute' | 'percentile' | null) => { if (v) p.setFeeType(v); }}>
            <ToggleButton value="absolute">{t('nemmosaic.levy_type_fixed')}</ToggleButton>
            <ToggleButton value="percentile">{t('nemmosaic.levy_type_percentile')}</ToggleButton>
          </ToggleButtonGroup>
        </>
      ) : (
        <FormRow label={t('nemmosaic.levy_type_short')} top>
          <RadioGroup row value={p.feeType} onChange={(e) => p.setFeeType(e.target.value as 'absolute' | 'percentile')}>
            <FormControlLabel value="absolute" control={<Radio size="small" />} label={t('nemmosaic.levy_type_fixed')} sx={{ mr: 3 }} />
            <FormControlLabel value="percentile" control={<Radio size="small" />} label={t('nemmosaic.levy_type_percentile')} />
          </RadioGroup>
        </FormRow>
      )}
      <Alert severity="info" icon={false} sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}>
        {p.feeType === 'percentile' ? (
          <Box>
            <Typography variant="body2" sx={{ mb: 1 }}>{t('nemmosaic.levy_percentile_intro')}</Typography>
            {examples.map((amount) => (
              <Typography key={amount.toString()} variant="body2" sx={{ py: 0.25, wordBreak: 'break-all' }}>
                {t('nemmosaic.levy_percentile_example', { amount: groupDigits(amount.toString()), sent: p.sentMosaic || '–', levy: levyAmount(amount * p.fee / 10000n), mosaic: p.mosaicId })}
              </Typography>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            {t('nemmosaic.levy_fixed_intro')} <b>{levyAmount(p.fee)}</b> {p.mosaicId}
          </Typography>
        )}
      </Alert>
    </>
  );
}

/** The 「徴収」 section of the creation form (shown while 「徴収を要求」 is checked). */
export default function NemLevyFormFields({ form, sentMosaic = '', stacked = false }: { form: NemLevyForm; sentMosaic?: string; stacked?: boolean }) {
  const { t } = useTranslation();
  if (!form.enabled) return null;
  return (
    <>
      {stacked
        ? <Typography sx={{ fontWeight: 'bold', mt: 2, mb: 1 }}>{t('nemmosaic.section_levy')}</Typography>
        : <SectionHead>{t('nemmosaic.section_levy')}</SectionHead>}
      {!stacked && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 2 }}>{t('nemmosaic.edit_levy_desc')}</Typography>}
      <NemLevyFieldsBox
        mosaic={form.mosaic}
        setMosaic={form.setMosaic}
        mosaicShapeOk={form.mosaicShapeOk}
        missing={form.missing}
        checking={form.check.state === 'loading'}
        feeHintDiv={form.check.state === 'found' ? form.check.info.divisibility : null}
        recipient={form.recipient}
        setRecipient={form.setRecipient}
        feeType={form.feeType}
        setFeeType={form.setFeeType}
        feeText={form.feeText}
        setFeeText={form.setFeeText}
        fee={form.fee}
        mosaicId={form.mosaicId}
        error={form.error}
        sentMosaic={sentMosaic}
        stacked={stacked}
      />
    </>
  );
}
