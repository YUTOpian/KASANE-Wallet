import { Box } from '@mui/material';
import Home from './Home';
import HomeGuides from '../../components/HomeGuides';

// ホーム画面。以前は 受け取る / ホーム / 送る をタブで切り替えていたが、受け取る・送る・取引履歴は
// Home に統合された（Home の受け取る/送るボタン → ダイアログ）。
export default function Top() {
  return (
    <Box sx={{ minHeight: '100vh', pb: 2 }}>
      <Home />
      <HomeGuides />
    </Box>
  );
}
