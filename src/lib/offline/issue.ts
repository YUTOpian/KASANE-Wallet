// オフライントランザクション（発行する側）。
//
// このウォレットが送るトランザクションは、どれも最後は「アナウンス」の入口を通る:
//   Symbol: announceSigned / announcePartial / announceCosignature（lib/symbol/api.ts, multisigApi.ts）
//   NEM   : announceNemPayload（lib/nem/api.ts）
// その入口で、端末がオフラインなら（または、ノードに届かなかったなら）送らずに、署名済みのトランザクションを
// QRコードにして画面に出す。あとで、オンラインの端末の「オフライントランザクション」の「読み込んで送信」で読み込んで送る。
//
// ここで作る QR の形式（KASANE の QR、lib/symbol/kasaneQr.ts と lib/nem/offline.ts）:
//   1つだけの Symbol トランザクション … `signed`（これまでの「署名・連署QR」と同じ）
//   1つだけの連署                     … `cosignature`
//   複数の Symbol トランザクション    … `bundle`（ロック → bonded、ハーベスト開始のリンク → 委任リクエストなど、送る順）
//   1つだけの NEM トランザクション    … `nem_signed`
//   複数の NEM トランザクション       … `nem_bundle`
//
// 投げるエラー（OfflineIssued）は「送れなかった」ことを呼び出し側に伝えるためのもの。画面は、これを失敗として
// 扱って構わない（送信後の処理に進まない）。QR は、同時に出る確認画面（OfflineIssueDialog）にある。
import { buildKasaneQr } from '../symbol/kasaneQr';
import type { BundleRole } from '../symbol/kasaneQr';
import { getNetworkConfig } from '../symbol/network';
import { buildNemBundleQr, buildNemSignedQr } from '../nem/offline';
import { getNemNetworkConfig } from '../nem/network';
import { useOfflineIssueStore } from '../../store/offlineIssueStore';
import { isDeviceOffline, isNetworkFailure } from './detect';
import type { IssuePart, OfflineIssue } from '../../store/offlineIssueStore';

export type { IssuePart, OfflineIssue } from '../../store/offlineIssueStore';
export { isDeviceOffline, isNetworkFailure };

/** 「送れなかった」エラーの文面。画面がそのまま出しても意味が通るように、日本語と英語を並べる。 */
export const OFFLINE_ISSUED_MESSAGE = 'オフラインのため送信せず、署名済みのトランザクションをQRコードにしました。 / Not sent (offline): a QR code of the signed transaction was created.';

export class OfflineIssued extends Error {
  issue: OfflineIssue;
  constructor(issue: OfflineIssue) {
    super(OFFLINE_ISSUED_MESSAGE);
    this.name = 'OfflineIssued';
    this.issue = issue;
  }
}

export function isOfflineIssued(e: unknown): e is OfflineIssued {
  return e instanceof OfflineIssued;
}

/** 画面が文面だけを持っているとき（Snackbar など）の判定。 */
export function isOfflineIssuedMessage(message: string): boolean {
  return message === OFFLINE_ISSUED_MESSAGE;
}

const HASH = /^[0-9a-fA-F]{64}$/;

/** その署名済みトランザクションを、QR（`signed` / `bundle`）にできるか（ハッシュが64桁の16進数であること）。 */
export function isIssuableSymbolTx(signed: { payload: string; hash: string }): boolean {
  return signed.payload !== '' && HASH.test(signed.hash);
}

function reasonNow(): OfflineIssue['reason'] {
  return isDeviceOffline() ? 'offline' : 'unreachable';
}

function show(chain: OfflineIssue['chain'], networkLabel: string, parts: IssuePart[], text: string, reason: OfflineIssue['reason']): never {
  const issue = useOfflineIssueStore.getState().show({ createdAt: Date.now(), chain, networkLabel, parts, text, reason });
  throw new OfflineIssued(issue);
}

export interface SymbolTxToIssue { payload: string; hash: string; role?: BundleRole }

/** 署名済みの Symbol トランザクションを（送らずに）QRにして、OfflineIssued を投げる。複数あるときは、送る順に並べる。 */
export function issueSymbolTransactions(txs: SymbolTxToIssue[], reason: OfflineIssue['reason'] = reasonNow()): never {
  if (txs.length === 0) throw new Error('offline issue: nothing to issue');
  const cfg = getNetworkConfig();
  const parts: IssuePart[] = txs.map((x) => ({ kind: 'symbol_tx', role: x.role ?? 'tx', payload: x.payload, hash: x.hash }));
  const single = txs.length === 1 && txs[0].role === undefined;
  const text = single
    ? buildKasaneQr({ kind: 'signed', payload: txs[0].payload, hash: txs[0].hash })
    : buildKasaneQr({ kind: 'bundle', items: txs.map((x) => ({ role: x.role ?? 'tx', payload: x.payload, hash: x.hash })) });
  return show('symbol', cfg.label, parts, text, reason);
}

/** 連署（親アグリゲートのハッシュへの署名）を、送らずにQRにして、OfflineIssued を投げる。 */
export function issueSymbolCosignature(body: { parentHash: string; signerPublicKey: string; signature: string; version: string }, reason: OfflineIssue['reason'] = reasonNow()): never {
  const cfg = getNetworkConfig();
  const text = buildKasaneQr({ kind: 'cosignature', parentHash: body.parentHash, signerPublicKey: body.signerPublicKey, signature: body.signature, version: body.version });
  return show('symbol', cfg.label, [{ kind: 'symbol_cosignature', ...body }], text, reason);
}

/** /transaction/announce の本文（`{"data","signature"}`）。 */
export interface NemBodyToIssue { data: string; signature: string }

/** `announceNemPayload` に渡る JSON 文字列を本文にする。読めなければ null（そのときは、いつもどおり送る）。 */
export function readNemAnnounceBody(payload: string): NemBodyToIssue | null {
  try {
    const json = JSON.parse(payload) as { data?: unknown; signature?: unknown };
    return typeof json.data === 'string' && typeof json.signature === 'string' ? { data: json.data, signature: json.signature } : null;
  } catch {
    return null;
  }
}

/** 署名済みの NEM トランザクションを（送らずに）QRにして、OfflineIssued を投げる。 */
export function issueNemTransactions(bodies: NemBodyToIssue[], reason: OfflineIssue['reason'] = reasonNow()): never {
  if (bodies.length === 0) throw new Error('offline issue: nothing to issue');
  const cfg = getNemNetworkConfig();
  const parts: IssuePart[] = bodies.map((b) => ({ kind: 'nem_tx', data: b.data, signature: b.signature }));
  const text = bodies.length === 1
    ? buildNemSignedQr(JSON.stringify(bodies[0]), cfg.networkByte)
    : buildNemBundleQr(bodies, cfg.networkByte);
  return show('nem', cfg.label, parts, text, reason);
}
