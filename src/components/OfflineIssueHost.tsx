import { lazy, Suspense } from 'react';
import { useOfflineIssueStore } from '../store/offlineIssueStore';

// 画面の外（lib/offline/issue.ts）で「オフラインのためQRにした」ときに、そのQRを出す確認画面を開く。アプリに1つだけ置く（MenuShell）。
// 確認画面は SDK を読み込むので、最初のバンドルには入れず、必要になったときだけ読み込む。
const OfflineIssueDialog = lazy(() => import('./OfflineIssueDialog'));

export default function OfflineIssueHost() {
  const open = useOfflineIssueStore((s) => s.issue !== null);
  return open ? <Suspense fallback={null}><OfflineIssueDialog /></Suspense> : null;
}
