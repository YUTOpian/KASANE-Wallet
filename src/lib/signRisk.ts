// 署名依頼（連署の依頼）の危険警告：依頼の「作成者」はアドレス帳で別に判定する（SignerTrustNotice / checkSignerTrust）。
// ここでは依頼の「中身」を調べて、注意や危険を出す。通信なし・画面なしの純粋な関数。
//   - 送金先 / 連署者に追加されるアドレスが、要注意の連絡先（ブロック済み）→ danger、アドレス帳にない → warning
//   - 送金先がネームスペース（エイリアス）で、実際の宛先を確認できない → warning
//   - マルチシグの設定変更（連署者・承認数）、承認数・削除数を減らす変更、アカウント制限の変更 → warning
//   - 中身を読み取れないトランザクション → warning、暗号化メッセージ → info
import type { Trust } from './addressBook';
import type { PartialItem } from './symbol/multisigApi';

export type RiskLevel = 'danger' | 'warning' | 'info';

export interface SignRisk {
  level: RiskLevel;
  /** i18n key suffix under `signrisk.` */
  code: string;
  params?: Record<string, string | number>;
}

/** 表示用に短くしたアドレス。 */
export const shortRiskAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const ORDER: Record<RiskLevel, number> = { danger: 0, warning: 1, info: 2 };

/**
 * `trustOfAddress` tells how the address book treats an address (self / white / contact / black / unknown).
 * The account an item is for (the multisig account) and the wallet's own accounts count as `self` and raise nothing.
 * The same warning is only listed once, however many items raise it. Most serious first.
 */
export function analyzeSignRisks(items: readonly PartialItem[], trustOfAddress: (address: string) => Trust): SignRisk[] {
  const out: SignRisk[] = [];
  const seen = new Set<string>();
  const add = (risk: SignRisk) => {
    const key = `${risk.code}|${JSON.stringify(risk.params ?? {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(risk);
  };
  const checkAddress = (address: string, account: string, blockedCode: string, unknownCode: string) => {
    if (!address || address === account) return;
    const trust = trustOfAddress(address);
    if (trust === 'black') add({ level: 'danger', code: blockedCode, params: { address: shortRiskAddress(address) } });
    else if (trust === 'unknown') add({ level: 'warning', code: unknownCode, params: { address: shortRiskAddress(address) } });
  };

  for (const item of items) {
    if (item.kind === 'transfer') {
      if (item.recipient.startsWith('@')) add({ level: 'warning', code: 'transfer_alias_recipient', params: { alias: item.recipient } });
      else checkAddress(item.recipient, item.account, 'transfer_to_blocked', 'transfer_to_unknown');
      if (item.encrypted) add({ level: 'info', code: 'transfer_encrypted' });
    } else if (item.kind === 'multisig') {
      add({ level: 'warning', code: 'multisig_change', params: { account: shortRiskAddress(item.account) } });
      if (item.minApprovalDelta < 0 || item.minRemovalDelta < 0) add({ level: 'warning', code: 'multisig_threshold_down' });
      for (const a of item.additions) checkAddress(a, item.account, 'multisig_add_blocked', 'multisig_add_unknown');
    } else if (item.kind === 'restriction') {
      add({ level: 'warning', code: 'restriction_change', params: { account: shortRiskAddress(item.account) } });
    } else if (item.kind === 'other') {
      add({ level: 'warning', code: 'other_unreadable', params: { type: `0x${item.type.toString(16).toUpperCase()}` } });
    }
  }
  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

export const hasDanger = (risks: readonly SignRisk[]): boolean => risks.some((r) => r.level === 'danger');
