// NEM DNS: ノードへの問い合わせと、レコードの登録（しくみは lib/nem/dns.ts の先頭）。
import { signWithLedger } from '../ledger/session';
import { SymbolSendError } from '../symbol/api';
import { announceNemPayload, nodeRequest } from './api';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, verifyNemSignature } from './crypto';
import {
  NEM_DNS_MAX_MESSAGE_BYTES, buildNemDnsMessage, findNemDnsRecord, nemDnsPointerPrivateKey, normalizeNemDnsName,
} from './dns';
import type { FoundNemDnsRecord, NemDnsRecord, RawDnsEntry } from './dns';
import { sendNemMultisigWrapped } from './multisigApi';
import { getNemNetworkConfig } from './network';
import {
  NEM_MULTISIG_WRAPPER_FEE, NEM_NAMESPACE_DURATION_BLOCKS, nemMessageByteLength, nemTransferFee, signNemTransfer, signNemTransferWith,
} from './tx';

export interface NemDnsPointer {
  namespace: string;
  publicKey: string;
  address: string;
}

/** ネームスペース（正規化済みの名前）のポインタアカウント。使っているネットワークのアドレスで返す。 */
export function nemDnsPointer(namespace: string, networkByte: number = getNemNetworkConfig().networkByte): NemDnsPointer {
  const { publicKey } = nemKeyPairFromPrivateKey(nemDnsPointerPrivateKey(namespace));
  return { namespace, publicKey, address: nemAddressFromPublicKey(publicKey, networkByte) };
}

/** code: 'invalid_name'（ネームスペース名の形が違う）／'namespace_not_found'（チェーンにない）。 */
export class NemDnsError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface NemDnsLookup {
  namespace: string;
  owner: string; // アドレス
  pointerAddress: string;
  /** ルートネームスペースの期限が切れているか（切れていると、持ち主が変わっているかもしれない）。調べられなければ false。 */
  expired: boolean;
  found: FoundNemDnsRecord | null;
}

const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 6;

type RawNamespaceInfo = { owner?: string; fqn?: string; height?: number };

async function readNamespace(id: string): Promise<RawNamespaceInfo> {
  try {
    return await nodeRequest<RawNamespaceInfo>(`/namespace?id=${encodeURIComponent(id)}`);
  } catch (e) {
    const status = (e as { status?: number }).status;
    // NIS1 answers an unknown namespace with an error status; a node that is down has no status at all.
    if (status === 400 || status === 404 || status === 500) throw new NemDnsError('namespace_not_found');
    throw e;
  }
}

/** 名前（"kasane" / "kasane.nem" / "a.b"）の DNS レコードを調べる。 */
export async function lookupNemDns(input: string): Promise<NemDnsLookup> {
  const namespace = normalizeNemDnsName(input);
  if (namespace === null) throw new NemDnsError('invalid_name');
  const networkByte = getNemNetworkConfig().networkByte;
  const pointer = nemDnsPointer(namespace, networkByte);

  const info = await readNamespace(namespace);
  const owner = (info.owner ?? '').replace(/-/g, '').toUpperCase();
  if (owner === '') throw new NemDnsError('namespace_not_found');

  // Expiry belongs to the root namespace; best effort (a failure here is not a reason to hide the record).
  let expired = false;
  try {
    const root = namespace.split('.')[0];
    const rootInfo = root === namespace ? info : await readNamespace(root);
    if (typeof rootInfo.height === 'number') {
      const { height } = await nodeRequest<{ height: number }>('/chain/height');
      expired = rootInfo.height + NEM_NAMESPACE_DURATION_BLOCKS <= height;
    }
  } catch {
    expired = false;
  }

  const addressOf = (publicKey: string) => nemAddressFromPublicKey(publicKey, networkByte);
  let found: FoundNemDnsRecord | null = null;
  let lastId: number | undefined;
  for (let page = 0; page < HISTORY_MAX_PAGES && found === null; page += 1) {
    const res = await nodeRequest<{ data?: RawDnsEntry[] }>(
      `/account/transfers/all?address=${pointer.address}&pageSize=${HISTORY_PAGE_SIZE}${lastId !== undefined ? `&id=${lastId}` : ''}`,
    );
    const entries = res.data ?? [];
    if (entries.length === 0) break;
    found = findNemDnsRecord(entries, owner, pointer.address, addressOf);
    lastId = entries[entries.length - 1].meta?.id;
    if (lastId === undefined) break;
  }
  return { namespace, owner, pointerAddress: pointer.address, expired, found };
}

// --- registering ------------------------------------------------------------------------------------------------
export interface NemDnsFee {
  /** レコードを送る送金の手数料（メッセージの長さで決まる）。マルチシグ名義ならこれをマルチシグアカウントが払う。 */
  transfer: bigint;
  /** マルチシグ名義のとき、署名するアカウントが払う外側の手数料（そうでなければ 0）。 */
  wrapper: bigint;
}

export function nemDnsFee(record: NemDnsRecord, multisig: boolean): NemDnsFee {
  return { transfer: nemTransferFee(0n, buildNemDnsMessage(record)), wrapper: multisig ? NEM_MULTISIG_WRAPPER_FEE : 0n };
}

export interface PublishNemDnsInput {
  namespace: string; // 正規化済み
  record: NemDnsRecord;
  /** 署名するアカウント（マルチシグ名義なら、連署者としての自分）。Ledger なら privateKey は空文字にして ledgerIndex を入れる。 */
  privateKey: string;
  publicKey: string;
  ledgerIndex?: number;
  /** ネームスペースの持ち主がマルチシグアカウントのとき、その公開鍵。 */
  multisigPublicKey?: string;
}

/**
 * DNS レコードを登録（更新）する: ポインタアカウントへ、DNS メッセージを付けた 0 XEM の送金をする。
 * 送るのは、ネームスペースの持ち主のアカウント（マルチシグなら、その名義）から。持ち主でないと、検索では無視される。
 */
export async function publishNemDns(input: PublishNemDnsInput): Promise<{ hash: string }> {
  const message = buildNemDnsMessage(input.record);
  if (nemMessageByteLength(message) > NEM_DNS_MAX_MESSAGE_BYTES) throw new SymbolSendError('message_too_long');
  const networkByte = getNemNetworkConfig().networkByte;
  const recipient = nemDnsPointer(input.namespace, networkByte).address;

  if (input.multisigPublicKey !== undefined) {
    if (input.ledgerIndex !== undefined || input.privateKey === '') throw new SymbolSendError('ledger_multisig_unsupported');
    return sendNemMultisigWrapped(input.privateKey, input.publicKey, input.multisigPublicKey, { kind: 'transfer', recipient, amount: 0n, message });
  }

  const params = { publicKey: input.publicKey, networkByte, recipient, amount: 0n, message, fee: nemTransferFee(0n, message) };
  const ledgerIndex = input.ledgerIndex;
  const payload = ledgerIndex !== undefined
    ? await signNemTransferWith((serialized) => signWithLedger('nem', ledgerIndex, input.publicKey, networkByte, serialized, verifyNemSignature), params)
    : signNemTransfer(input.privateKey, params);
  return announceNemPayload(payload);
}
