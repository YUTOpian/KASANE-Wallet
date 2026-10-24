import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { LinkTiles } from '../../components/LinkList';

// リンク集: 公式リンク（ドキュメント・コミュニティ・エクスプローラー・Discord、テストネットではファウセットも）をタイルで並べる。
export default function Links() {
  const { t } = useTranslation();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', px: { xs: 2, md: 3 }, pb: 3 }}>
      <Typography sx={{ m: 1, mt: 3, fontWeight: 700 }}>{t('links.title')}</Typography>
      <LinkTiles />
    </Box>
  );
}
