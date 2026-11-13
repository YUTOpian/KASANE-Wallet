// アカウント／プロファイルを削除したとき、そのアカウントに結びついてこの端末に残るデータを消す。
// ウォレット本体（暗号化した秘密鍵・ニーモニック・ハーベスト用の鍵）は Wallets から外れた時点で消える。
// ここで消すのは、ウォレットのIDやプロファイルのキーを名前に含めて localStorage に別保存したものと、
// メモリ上の表示キャッシュ。削除後に同じ秘密鍵や .wlt をもう一度読み込んでも、昔の設定を引きずらない。
import { clearHomeCache } from './homeCache';
import { LOGIN_PASSWORD_KEY_PREFIX } from './loginLock';
import { useAggregateStore } from '../store/aggregateStore';

// 保存しているキーの形（lib/nem/harvest.ts / lib/nem/multisigHarvest.ts / lib/onboarding.ts と揃える）:
//   kasane.nem.harvestNode.<ネットワーク>.<walletId>
//   kasane.nem.multisigRemote.<ネットワーク>.<walletId>.<マルチシグのアドレス>
//   kasane.backupDone.<profileKey>
const HARVEST_NODE_PREFIX = 'kasane.nem.harvestNode.';
const MULTISIG_REMOTE_PREFIX = 'kasane.nem.multisigRemote.';
const BACKUP_DONE_PREFIX = 'kasane.backupDone.';

/** 消すべきキーかどうか。walletIds はこの削除で無くなるウォレットのID、profileKeys は無くなるプロファイルのキー。 */
export function isPurgeKey(key: string, walletIds: ReadonlySet<string>, profileKeys: ReadonlySet<string>): boolean {
  if (key.startsWith(HARVEST_NODE_PREFIX)) {
    const [, id = ''] = key.slice(HARVEST_NODE_PREFIX.length).split(/\.(.*)/s); // ネットワーク名の後ろ全部がID
    return walletIds.has(id);
  }
  if (key.startsWith(MULTISIG_REMOTE_PREFIX)) {
    const rest = key.slice(MULTISIG_REMOTE_PREFIX.length);
    const afterNet = rest.slice(rest.indexOf('.') + 1);
    // walletId は '.' を含まない（Wallet.createId）。その後ろにアドレスが続く。
    return walletIds.has(afterNet.split('.')[0]);
  }
  if (key.startsWith(BACKUP_DONE_PREFIX)) {
    return profileKeys.has(key.slice(BACKUP_DONE_PREFIX.length));
  }
  if (key.startsWith(LOGIN_PASSWORD_KEY_PREFIX)) {
    return profileKeys.has(key.slice(LOGIN_PASSWORD_KEY_PREFIX.length));
  }
  return false;
}

/** 削除したアカウント（プロファイルごと消したときは、そのプロファイルの全アカウント）の、残りのデータを消す。失敗しても削除自体は成立させる。 */
export function purgeAccountData(removed: { id: string; profileKey: string }[], opts: { profileRemoved: boolean }): void {
  const walletIds = new Set(removed.map((w) => w.id));
  const profileKeys = new Set(opts.profileRemoved ? removed.map((w) => w.profileKey) : []);
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && isPurgeKey(key, walletIds, profileKeys)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // localStorage が使えない環境では、そもそも何も保存していない。
  }
  // 画面に残っている表示用のデータ（ホームの残高、作りかけのアグリゲート）も捨てる。
  clearHomeCache();
  useAggregateStore.getState().clear();
}
