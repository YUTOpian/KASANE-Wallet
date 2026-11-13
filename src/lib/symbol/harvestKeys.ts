// ハーベストのキーリンクの個別管理: リモート（アカウントキー）／VRF／ノードの各キーを、公開鍵を指定して1つずつリンク・解除・付け替えする。
// 「開始（自動生成）」と「全解除」は api.ts の startHarvesting / stopHarvesting。ここは通信なしで、どのリンク／解除を送るかを決める。
import { harvestPublicKeyOf } from './tx';
import type { HarvestLink, HarvestLinkKind } from './tx';
import type { HarvestStatus } from './api';

export const HARVEST_LINK_KINDS: HarvestLinkKind[] = ['remote', 'vrf', 'node'];

export type KeyAction = 'link' | 'unlink' | 'replace';
export type KeyChangeError = 'not_linked' | 'already_linked' | 'invalid_key' | 'own_key' | 'same_key' | 'duplicate_key';
export type KeyChangePlan = { ok: true; links: HarvestLink[] } | { ok: false; error: KeyChangeError };
export type LinkedKeys = Pick<HarvestStatus, 'remotePublicKey' | 'vrfPublicKey' | 'nodePublicKey'>;

export const isPublicKeyHex = (text: string): boolean => /^[0-9a-fA-F]{64}$/.test(text);

/** The key of this kind that is linked on the chain now (upper case), or null. */
export function currentKey(status: LinkedKeys, kind: HarvestLinkKind): string | null {
  const key = kind === 'remote' ? status.remotePublicKey : kind === 'vrf' ? status.vrfPublicKey : status.nodePublicKey;
  return key ? key.toUpperCase() : null;
}

/**
 * What to send to link / unlink / replace one key.
 * - link: the kind must not be linked yet (the network refuses a second link); `newKey` is linked.
 * - unlink: the key that is linked now is removed (an unlink must name exactly what is linked, so it is read from the chain, not typed).
 * - replace: unlink the current key and link `newKey` in the same aggregate (the network does not allow linking over an existing link).
 * `newKey` must be 64 hex chars, not the account's own public key, and not a key that is already linked as another kind.
 */
export function planKeyChange(status: LinkedKeys, kind: HarvestLinkKind, action: KeyAction, newKey: string, ownPublicKey: string): KeyChangePlan {
  const current = currentKey(status, kind);
  if (action === 'unlink') {
    return current ? { ok: true, links: [{ kind, publicKey: current, link: false }] } : { ok: false, error: 'not_linked' };
  }
  if (action === 'link' && current) return { ok: false, error: 'already_linked' };
  if (action === 'replace' && !current) return { ok: false, error: 'not_linked' };
  const key = newKey.trim().toUpperCase();
  if (!isPublicKeyHex(key)) return { ok: false, error: 'invalid_key' };
  if (key === ownPublicKey.toUpperCase()) return { ok: false, error: 'own_key' };
  if (action === 'replace' && key === current) return { ok: false, error: 'same_key' };
  const others = HARVEST_LINK_KINDS.filter((k) => k !== kind).map((k) => currentKey(status, k));
  if (others.includes(key)) return { ok: false, error: 'duplicate_key' };
  const links: HarvestLink[] = [];
  if (action === 'replace' && current) links.push({ kind, publicKey: current, link: false });
  links.push({ kind, publicKey: key, link: true });
  return { ok: true, links };
}

// --- 委任リクエストの再送 ------------------------------------------------------------------------
// ノードが依頼を受け取れなかったとき（ノードの再起動・データ消失など）に、リモート／VRFの秘密鍵を同じノードへ送り直す。
// リンクは変えず、ノードへの暗号化メッセージ（FormPersistentDelegationRequest）だけを送る。
// 秘密鍵はチェーン上に無く、開始時にウォレットは保存しない（ノードが持つ）ので、持ち主が入力する。
// 入力した秘密鍵が、チェーン上でリンクされているリモート／VRFの公開鍵と一致することを確かめてから送る
// （違う鍵を送ってもノードは何もできず、鍵を無駄にさらすだけなので）。
export type ResendError = 'not_linked' | 'invalid_remote' | 'invalid_vrf' | 'same_key' | 'remote_mismatch' | 'vrf_mismatch';
export type ResendPlan = { ok: true; nodePublicKey: string; remotePrivateKey: string; vrfPrivateKey: string } | { ok: false; error: ResendError };

/**
 * 再送できるか判定する。3つのリンク（リモート・VRF・ノード）が揃っていて、入力した2つの秘密鍵が
 * リンク中のリモート・VRFの公開鍵に対応しているときだけ、送り先（リンク中のノード）と整えた鍵を返す。
 * `publicKeyOf` は秘密鍵から公開鍵を作る関数（テストで差し替えられる）。
 */
export function planDelegationResend(
  status: LinkedKeys, remotePrivateKey: string, vrfPrivateKey: string,
  publicKeyOf: (privateKey: string) => string | null = harvestPublicKeyOf,
): ResendPlan {
  const remote = currentKey(status, 'remote');
  const vrf = currentKey(status, 'vrf');
  const node = currentKey(status, 'node');
  if (!remote || !vrf || !node) return { ok: false, error: 'not_linked' };
  const remoteKey = remotePrivateKey.trim().toUpperCase();
  const vrfKey = vrfPrivateKey.trim().toUpperCase();
  if (!isPublicKeyHex(remoteKey)) return { ok: false, error: 'invalid_remote' };
  if (!isPublicKeyHex(vrfKey)) return { ok: false, error: 'invalid_vrf' };
  if (remoteKey === vrfKey) return { ok: false, error: 'same_key' };
  if (publicKeyOf(remoteKey)?.toUpperCase() !== remote) return { ok: false, error: 'remote_mismatch' };
  if (publicKeyOf(vrfKey)?.toUpperCase() !== vrf) return { ok: false, error: 'vrf_mismatch' };
  return { ok: true, nodePublicKey: node, remotePrivateKey: remoteKey, vrfPrivateKey: vrfKey };
}
