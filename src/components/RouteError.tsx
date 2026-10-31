import { Box, Button, Typography } from '@mui/material';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// 画面の表示中に想定外のエラーが起きたときの画面。React の生のエラー文ではなく、再読み込みを促す。
// 古いバージョンのファイルを読んだ・拡張機能の状態が変わった、といった場合は、再読み込みで直ることが多い。
export default function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error ? error.message : String(error);
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, textAlign: 'center' }}>
      <Box sx={{ maxWidth: 420 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>{t('common.error_title')}</Typography>
        <Typography sx={{ fontSize: 14, mb: 2 }}>{t('common.error_body')}</Typography>
        <Button variant="contained" onClick={() => window.location.reload()}>{t('common.reload')}</Button>
        <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'text.secondary', wordBreak: 'break-word' }}>{detail}</Typography>
      </Box>
    </Box>
  );
}
