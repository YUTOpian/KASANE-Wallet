import { useTranslation } from 'react-i18next';
import DesktopPage from '../../components/DesktopPage';
import ApostilleTabs from './ApostilleTabs';

// NEM の「アポスティーユ」（公証）の単独の画面（サービス → アポスティーユ）。Home の「アポスティーユ」リボンと同じ内容。
export default function ApostillePage() {
  const { t } = useTranslation();
  return (
    <DesktopPage title={t('apostille.title')}>
      <ApostilleTabs />
    </DesktopPage>
  );
}
