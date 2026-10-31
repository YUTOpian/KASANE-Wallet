// アポスティーユの画面（作成・監査・履歴・エクスプローラー）を、NEM と Symbol の両方で使うための「チェーンごとの違い」をまとめたもの。
// 画面は chain を知らずに、ここから返る関数を呼ぶだけにする。違いは、署名の方式・送金の作り方・手数料・宛先（シンク）・記録の読み方・エクスプローラーのリンク。
import { formatAtomic } from './symbol/amount';
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from './symbol/constants';
import { getNetworkConfig as getSymbolNetworkConfig } from './symbol/network';
import { SymbolSendError, explorerAccountUrl as symbolAccountUrl, explorerTxUrl as symbolTxUrl } from './symbol/api';
import { prettyAddress as prettySymbolAddress } from './symbol/crypto';
import {
  buildSymbolApostilleMessage, symbolApostilleSink, symbolDedicatedAccount, verifySymbolApostille,
} from './symbol/apostille';
import {
  fetchSymbolApostilleExplorerPage, fetchSymbolApostilleTx, quoteSymbolApostilleFee, sendSymbolApostille, symbolAddressOfSigner,
} from './symbol/apostilleApi';
import {
  apostilleFee, apostilleSink, buildApostilleMessage, dedicatedAccount, verifyApostille,
} from './nem/apostille';
import type { ApostilleHashing, AuditVerdict, BuiltApostille } from './nem/apostille';
import { announceNemPayload, fetchNemTransactionByHash, nemExplorerAccountUrl, nemExplorerTxUrl, nodeRequest as nemNodeRequest } from './nem/api';
import { fetchApostilleExplorerPage } from './nem/apostilleExplorer';
import type { ApostilleExplorerPage } from './nem/apostilleExplorer';
import { NEM_CURRENCY_DIVISIBILITY, NEM_CURRENCY_SYMBOL } from './nem/constants';
import { nemAddressFromPublicKey, prettyNemAddress } from './nem/crypto';
import { getNemNetworkConfig } from './nem/network';
import { signNemTransfer } from './nem/tx';

export interface ApostilleSender {
  privateKey: string;
  publicKey: string;
  address: string;
}

export interface ApostilleChainDriver {
  chain: ChainKey;
  /** "NEM" / "Symbol", for the texts. */
  name: string;
  /** i18next context of the texts that differ by chain ('' for NEM, whose keys have no suffix). */
  context: 'symbol' | undefined;
  /** "mainnet" / "testnet" / "mijin", for the certificate. */
  network: string;
  /** The account public apostilles are sent to. */
  sink: () => string;
  /** The dedicated account of a signed apostille (an address). */
  dedicatedAddress: (ownerPrivateKey: string, fileName: string) => string;
  build: (file: Uint8Array, hashing: ApostilleHashing, signed: boolean, privateKey?: string) => BuiltApostille;
  /** Fee of the transfer carrying a message of `messageLength` bytes (the apostille message, 5 + hash or signature bytes). */
  fee: (messageLength: number) => Promise<bigint>;
  formatFee: (fee: bigint) => string;
  /** Signs and announces the apostille; returns the transaction hash. */
  send: (sender: ApostilleSender, recipient: string, built: BuiltApostille, fee: bigint) => Promise<{ hash: string }>;
  /** The transfer behind a hash: who signed it and what apostille message it carries. Null = the node does not know it. */
  fetchTx: (hash: string) => Promise<{ signer: string; payloadHex: string } | null>;
  verify: (file: Uint8Array, payloadHex: string, signer: string) => AuditVerdict;
  addressOfSigner: (publicKey: string) => string;
  prettyAddress: (address: string) => string;
  txUrl: (hash: string) => string;
  accountUrl: (address: string) => string;
  explorerPage: (sink: string, cursor?: number) => Promise<ApostilleExplorerPage>;
  /** Maps what a failed send threw to the `apostille.error_<kind>` key and a detail. */
  classifyError: (error: unknown) => { kind: string; detail: string };
}

/** Maps a node's rejection code (Symbol: Failure_Core_Insufficient_Balance, NEM: FAILURE_INSUFFICIENT_BALANCE) to a message key + detail. */
export function classifyApostilleError(error: unknown): { kind: string; detail: string } {
  const code = error instanceof SymbolSendError ? error.code : '';
  const detail = error instanceof Error ? error.message : String(error);
  const c = code.toUpperCase();
  const more = code && code !== detail ? `${code}: ${detail}` : detail;
  if (c.includes('INSUFFICIENT_BALANCE')) return { kind: 'insufficient_balance', detail };
  if (c.includes('DEADLINE') || c.includes('TIMESTAMP')) return { kind: 'deadline', detail };
  if (c.includes('WRONG_NETWORK')) return { kind: 'wrong_network', detail };
  if (c.includes('EXPIRED')) return { kind: 'expired', detail };
  return { kind: 'unknown', detail: more };
}

const nemDriver: ApostilleChainDriver = {
  chain: 'nem',
  name: 'NEM',
  context: undefined,
  get network() { return getNemNetworkConfig().key; },
  sink: () => apostilleSink(getNemNetworkConfig().networkByte),
  dedicatedAddress: (key, name) => dedicatedAccount(key, name, getNemNetworkConfig().networkByte).address,
  build: buildApostilleMessage,
  fee: async (len) => apostilleFee(new Uint8Array(len)),
  formatFee: (fee) => `${formatAtomic(fee, NEM_CURRENCY_DIVISIBILITY)} ${NEM_CURRENCY_SYMBOL}`,
  send: async (sender, recipient, built, fee) => {
    const cfg = getNemNetworkConfig();
    const payload = signNemTransfer(sender.privateKey, {
      publicKey: sender.publicKey, networkByte: cfg.networkByte, recipient, amount: 0n, messageBytes: built.message, fee,
    });
    return announceNemPayload(payload);
  },
  fetchTx: async (hash) => {
    const tx = await fetchNemTransactionByHash(hash);
    return tx ? { signer: tx.signer, payloadHex: tx.payloadHex } : null;
  },
  verify: (file, payloadHex, signer) => verifyApostille(file, payloadHex, signer),
  addressOfSigner: (publicKey) => nemAddressFromPublicKey(publicKey, getNemNetworkConfig().networkByte),
  prettyAddress: prettyNemAddress,
  txUrl: nemExplorerTxUrl,
  accountUrl: nemExplorerAccountUrl,
  explorerPage: (sink, cursor) => fetchApostilleExplorerPage(nemNodeRequest, sink, cursor),
  classifyError: classifyApostilleError,
};

const symbolDriver: ApostilleChainDriver = {
  chain: 'symbol',
  name: 'Symbol',
  context: 'symbol',
  get network() { return getSymbolNetworkConfig().key; },
  sink: () => symbolApostilleSink(getSymbolNetworkConfig().networkByte),
  dedicatedAddress: (key, name) => symbolDedicatedAccount(key, name, getSymbolNetworkConfig().networkByte).address,
  build: buildSymbolApostilleMessage,
  fee: (len) => quoteSymbolApostilleFee(new Uint8Array(len)),
  formatFee: (fee) => `${formatAtomic(fee, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`,
  send: (sender, recipient, built) => sendSymbolApostille({ privateKey: sender.privateKey, publicKey: sender.publicKey, recipient, message: built.message }),
  fetchTx: async (hash) => {
    const tx = await fetchSymbolApostilleTx(hash);
    return tx ? { signer: tx.signer, payloadHex: tx.payloadHex } : null;
  },
  verify: verifySymbolApostille,
  addressOfSigner: symbolAddressOfSigner,
  prettyAddress: prettySymbolAddress,
  txUrl: symbolTxUrl,
  accountUrl: symbolAccountUrl,
  explorerPage: (sink, cursor) => fetchSymbolApostilleExplorerPage(sink, cursor),
  classifyError: classifyApostilleError,
};

/** The driver of the chain the app is working with now (or of `chain`). */
export function apostilleDriver(chain: ChainKey = getChain()): ApostilleChainDriver {
  return chain === 'symbol' ? symbolDriver : nemDriver;
}
