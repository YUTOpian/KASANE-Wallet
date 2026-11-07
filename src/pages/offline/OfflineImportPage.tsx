import { useEffect, useState } from 'react';
import { Alert, Typography } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CHAIN_ORDER } from '../../lib/chain';
import type { ChainKey } from '../../lib/chain';
import { isDeviceOffline } from '../../lib/offline/issue';
import { useAppStore } from '../../store/appStore';
import { SignQrReader } from '../signqr/SignQrPage';
import OfflineChainSelect from './OfflineChainSelect';
import OfflineShell from './OfflineShell';

// 「読み込んで送信」: オフラインで作ったトランザクション（QRコード・JSON・ファイル）を読み込んで、ネットワークに送る。
// 連署とは関係がないので、「転送トランザクション」「トランザクションに連署」と並ぶ3つ目のタブにしている（ポップアップではない）。
// プロファイル選択から開くので、プロファイルが無い（鍵を持たない）端末でも使える: 署名済みのものを送るだけで、署名はしない。
// Symbol のトランザクション・ロック付きの連署待ち・連署・複数まとめたもの、NEM のトランザクション・複数まとめたもの、を読める。
// 読み込んだだけでは何も送らない。内容を確認して「送信」を押したときだけ送る。

export default function OfflineImportPage() {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  // 「オフラインで作成しました」の画面から「この端末で今すぐ読み込む」で来たときは、その QR がここに渡ってくる。
  const state = useLocation().state as { text?: unknown; chain?: unknown } | null;
  const handed = state?.text;
  // Symbol か NEM か: 確認画面から来たときは、そのQRのチェーン。
  const [target, setTarget] = useState<ChainKey>(state?.chain === 'nem' ? 'nem' : 'symbol');
  const [offline, setOffline] = useState(isDeviceOffline());

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  return (
    <OfflineShell tab="import" steps={[]} step={0}>
      <Typography sx={{ fontWeight: 'bold', fontSize: '0.95rem', mb: 0.5 }}>{t('offline_ui.send_title')}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8, mb: 1 }}>{t('offline_ui.send_desc')}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.8, mb: 2 }}>{t('offline_tx.import_lead')}</Typography>
      {offline && <Alert severity="warning" sx={{ mb: 2 }}>{t('offline_tx.reader_offline')}</Alert>}
      <OfflineChainSelect chains={CHAIN_ORDER} chain={target} onChain={setTarget} />
      {/* 別のブロックチェーン・ネットワークに切り替えたら、読み込み途中のものは捨てて、最初から。 */}
      <SignQrReader key={`${target}:${network}`} compact fill chain={target} initialText={typeof handed === 'string' ? handed : undefined} />
    </OfflineShell>
  );
}
