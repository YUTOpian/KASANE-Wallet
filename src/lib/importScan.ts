// ニーモニックのインポート時に、導出した各アカウント（インデックス 0〜N-1）のアドレスをネットワークに問い合わせ、
// 「使われている（疎通する）」ものを見分ける。ここで調べるのは公開情報（アドレスと残高）だけで、秘密鍵は扱わない。
import type { ChainKey } from './chain';
import { getNetwork, getNetworkConfig } from './symbol/network';
import { getNemNetworkConfig } from './nem/network';
import { MnemonicHelper, PROFILE_ACCOUNT_COUNT, SYMBOL_TESTNET_COIN_TYPE } from './symbol/hd';
import { addressFromPublicKey, prettyAddress } from './symbol/crypto';
import { nodeRequest as symbolRequest } from './symbol/api';
import { nemAccountsFromMnemonic } from './nem/hd';
import { nemAddressFromPublicKey, prettyNemAddress } from './nem/crypto';
import { nodeRequest as nemRequest } from './nem/api';
import { formatAtomic } from './symbol/amount';

export interface ScannedAccount {
  index: number;
  /** ハイフンなしのアドレス。 */
  address: string;
  prettyAddress: string;
  /** ネットワークに記録がある（公開鍵が公開済み、または残高・モザイクがある）。null = 問い合わせに失敗。 */
  active: boolean | null;
  /** 基軸通貨（XYM / XEM）の残高。問い合わせに失敗したら null。 */
  balance: string | null;
}

/** 画面に出すアドレスの一覧（ネットワーク問い合わせなし）。秘密鍵は返さない。 */
export function deriveAddresses(phrase: string, chain: ChainKey, count: number = PROFILE_ACCOUNT_COUNT): ScannedAccount[] {
  const networkByte = chain === 'nem' ? getNemNetworkConfig().networkByte : getNetworkConfig().networkByte;
  const publicKeys: string[] = chain === 'nem'
    ? nemAccountsFromMnemonic(phrase, count).map((a) => a.publicKey)
    // テストネットは公式ウォレット互換（コイン種別 1）の鍵。ほかはメインネットの鍵。
    : MnemonicHelper.accountsFromMnemonic(phrase, count, getNetwork() === 'testnet' ? SYMBOL_TESTNET_COIN_TYPE : undefined).map((a) => a.publicKey);
  return publicKeys.map((publicKey, index) => {
    const address = chain === 'nem' ? nemAddressFromPublicKey(publicKey, networkByte) : addressFromPublicKey(publicKey, networkByte);
    return {
      index,
      address,
      prettyAddress: chain === 'nem' ? prettyNemAddress(address) : prettyAddress(address),
      active: null,
      balance: null,
    };
  });
}

const ZERO_KEY = /^0+$/;

async function lookupSymbol(address: string): Promise<{ active: boolean; balance: string }> {
  try {
    const res = await symbolRequest<{ account: { publicKey?: string; mosaics?: Array<{ id: string; amount: string }> } }>(`/accounts/${address}`);
    const mosaics = res.account.mosaics ?? [];
    const currencyId = getNetworkConfig().currencyMosaicId.toUpperCase();
    const native = mosaics.find((m) => m.id.toUpperCase() === currencyId);
    return {
      active: mosaics.length > 0 || (!!res.account.publicKey && !ZERO_KEY.test(res.account.publicKey)),
      balance: formatAtomic(BigInt(native?.amount ?? '0'), 6),
    };
  } catch (e) {
    // 404 = ノードがまだ一度も見たことのないアドレス（使われていない）。
    if ((e as { status?: number }).status === 404) return { active: false, balance: '0' };
    throw e;
  }
}

async function lookupNem(address: string): Promise<{ active: boolean; balance: string }> {
  const res = await nemRequest<{ account?: { balance?: number; publicKey?: string | null } }>(`/account/get?address=${address}`);
  const balance = BigInt(res.account?.balance ?? 0);
  return { active: balance > 0n || !!res.account?.publicKey, balance: formatAtomic(balance, 6) };
}

/** 各アドレスを順に問い合わせる（ノードへの負荷を抑えるため、同時に投げるのは少数）。失敗した行は active / balance が null のまま。 */
export async function scanAccounts(
  accounts: ScannedAccount[],
  chain: ChainKey,
  onRow: (row: ScannedAccount) => void,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const lookup = chain === 'nem' ? lookupNem : lookupSymbol;
  const queue = [...accounts];
  const worker = async () => {
    for (let row = queue.shift(); row && !shouldStop(); row = queue.shift()) {
      try {
        const r = await lookup(row.address);
        onRow({ ...row, active: r.active, balance: r.balance });
      } catch {
        onRow({ ...row, active: null, balance: null });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
