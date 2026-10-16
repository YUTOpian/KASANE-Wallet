import { useEffect, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import SwipeDismiss from './SwipeDismiss';
import { useTranslation } from 'react-i18next';
import { onNodeSwitched } from '../lib/symbol/api';

/** Tells the person when requests moved to another node because the picked one stopped answering. */
export default function NodeSwitchNotice() {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  useEffect(() => onNodeSwitched((_from, to) => setUrl(to.replace(/^https?:\/\//, ''))), []);
  return (
    <Snackbar open={url !== ''} autoHideDuration={6000} onClose={() => setUrl('')} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <SwipeDismiss onDismiss={() => setUrl('')}>
        <Alert severity="warning" onClose={() => setUrl('')} sx={{ width: '100%' }}>{t('settings.snode_switched', { url })}</Alert>
      </SwipeDismiss>
    </Snackbar>
  );
}
