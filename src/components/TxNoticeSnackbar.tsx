import { Alert, Button, Snackbar } from '@mui/material';
import { useTxNoticeStore } from '../store/txNoticeStore';
import SwipeDismiss from './SwipeDismiss';

/**
 * 送信後の通知（store/txNoticeStore.ts）を、画面の下にトーストで出す。アプリに1つだけ置く（App.tsx）。
 * モザイク・ネームスペース・マルチシグ・アグリゲートなどは、送信しても「完了画面」へは遷移せず、これだけが出る。
 */
export default function TxNoticeSnackbar() {
  const notice = useTxNoticeStore((s) => s.notice);
  const clear = useTxNoticeStore((s) => s.clear);

  return (
    <Snackbar
      // 通知ごとに作り直して、続けて送ったときも表示時間をやり直す。
      key={notice?.id ?? 0}
      open={notice !== null}
      autoHideDuration={12000}
      onClose={(_, reason) => { if (reason !== 'clickaway') clear(); }}
    >
      <SwipeDismiss onDismiss={clear}>
      <Alert
        severity="success"
        onClose={clear}
        sx={{ width: '100%', maxWidth: 560, alignItems: 'center', textAlign: 'left' }}
        action={notice?.explorerUrl ? (
          <Button color="inherit" size="small" href={notice.explorerUrl} target="_blank" rel="noopener" sx={{ whiteSpace: 'nowrap' }}>
            {notice.explorerLabel}
          </Button>
        ) : undefined}
      >
        {(notice?.lines ?? []).map((line, i) => <span key={i}>{line}<br /></span>)}
      </Alert>
      </SwipeDismiss>
    </Snackbar>
  );
}
