// このブラウザ（KASANE と同じアドレス）に Symbol 公式ウォレットのプロファイルがあるかを探す。
// 公式ウォレットは localStorage の `profiles` / `accounts` に持っている。ブラウザはアドレス（ドメイン）ごとにデータを分けるので、
// 公式ウォレットが別のアドレスで動いているときは、ここからは見えない（その場合は「読み込み」から貼り付け／ファイルで）。
// 見つけても、秘密鍵は公式ウォレットのパスワードで暗号化されているので、パスワード無しでは開けない。
// ここでは「見つける」ところまで（パスワード無しで読める公開鍵だけを見る）。
import { parseOfficialData } from './format';
import { existingSymbolPublicKeys, listOfficialProfiles, officialPublicKeys } from './convert';
import type { OfficialProfileSummary } from './convert';

// 「今後は聞かない」を選んだプロファイル。プロファイル名と最初の公開鍵の組で覚える（同じ名前の別のプロファイルを黙らせないため）。
const DISMISSED_KEY = 'kasane.officialProfileDismissed';

/** 公式ウォレットの localStorage の中身（`profiles` と `accounts`）を、読み込み画面と同じ形の JSON にして返す。無ければ null。 */
export function readOfficialLocalStorage(): string | null {
  try {
    const profiles = localStorage.getItem('profiles');
    if (!profiles) return null;
    return JSON.stringify({ profiles, accounts: localStorage.getItem('accounts') });
  } catch {
    return null;
  }
}

function dismissedEntries(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const entryOf = (profileName: string, firstKey: string) => `${profileName}|${firstKey}`;

export interface OfficialFound {
  /** 読み込み画面に渡せる形の、公式ウォレットのデータ（JSON の文字列）。 */
  text: string;
  /** まだ KASANE に無く、「聞かない」にもしていないプロファイル。 */
  profiles: OfficialProfileSummary[];
}

/**
 * KASANE にまだ無い公式ウォレットのプロファイルを探す。無い・読めないときは null（エラーにはしない）。
 * 起動時の自動の確認は「今後は聞かない」を守る。手動の読み込み画面は、ignoreDismissed で「聞かない」にしたものも出す
 * （KASANE から削除したあとでも、ブラウザに残っている限り、また読み込めるように）。
 */
export async function findNewOfficialProfiles(opts: { ignoreDismissed?: boolean } = {}): Promise<OfficialFound | null> {
  try {
    const text = readOfficialLocalStorage();
    if (text === null) return null;
    const data = parseOfficialData(text);
    const silenced = new Set(opts.ignoreDismissed ? [] : dismissedEntries());
    // すでに KASANE にある鍵を含むプロファイルは、読み込み済みとみなす（読み込みも、重複する鍵があると断る）。
    const existing = await existingSymbolPublicKeys();
    const profiles = listOfficialProfiles(data).filter((p) => {
      if (p.accountCount === 0) return false;
      const keys = officialPublicKeys(data, p.profileName);
      if (keys.some((k) => existing.has(k))) return false;
      return !silenced.has(entryOf(p.profileName, keys[0] ?? ''));
    });
    return profiles.length > 0 ? { text, profiles } : null;
  } catch {
    return null;
  }
}

/** 「今後は聞かない」: 指定したプロファイルを、次から探さない。 */
export function dismissOfficialProfiles(text: string, profileNames: string[]): void {
  try {
    const data = parseOfficialData(text);
    const next = new Set(dismissedEntries());
    for (const name of profileNames) next.add(entryOf(name, officialPublicKeys(data, name)[0] ?? ''));
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
  } catch {
    // 保存できない環境では、次回また聞く。
  }
}
