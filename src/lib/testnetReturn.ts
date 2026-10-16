import type { ChainKey } from './chain';
import { fetchBalances, quoteFee, sendTransfer } from './symbol/api';
import { fetchNemXemBalance, sendNemTransfer } from './nem/api';
import { nemTransferFee } from './nem/tx';
import { NETWORKS } from './symbol/constants';
import { getNetwork } from './symbol/network';
import { isValidAddress, normalizeAddress, prettyAddress } from './symbol/crypto';
import { isValidNemAddress, normalizeNemAddress, prettyNemAddress } from './nem/crypto';

// テストネットのXYM / XEM の返還。設定 > 「テストXYMを返還」「テストXEMを返還」から、残高から手数料を引いた
// 全額を、次の返還先へ1回の送金で送る。テストネット（Symbol / NEM どちらも network byte 0x98）のときだけ使う。
export const TESTNET_RETURN_ADDRESS: Record<ChainKey, string> = {
  symbol: 'TCNQVXTIQIDQOGTYW6HLZ5TLJALE2BO6VMIAHUA', // テストXYM
  nem: 'TCSMSAMGFNWZVWFTJ34GKIZKYQNDJOVICWIRMVQY', // テストXEM
};

const TESTNET_BYTE = 0x98;
const DIVISIBILITY = 6; // XYM and XEM both have 6 decimals

export interface TestnetReturnPlan {
  chain: ChainKey;
  recipient: string; // normalised (no hyphens)
  recipientPretty: string;
  balance: bigint; // atomic units
  fee: bigint; // atomic units
  amount: bigint; // balance - fee (0 when nothing can be returned)
  divisibility: number;
  symbol: string;
}

/** The return address is fixed in the code; it is still checked (checksum + testnet) right before it is used. */
export function returnRecipient(chain: ChainKey): { normalized: string; pretty: string } {
  const raw = TESTNET_RETURN_ADDRESS[chain];
  if (chain === 'nem') {
    if (!isValidNemAddress(raw, TESTNET_BYTE)) throw new Error('invalid_return_address');
    return { normalized: normalizeNemAddress(raw), pretty: prettyNemAddress(raw) };
  }
  if (!isValidAddress(raw, TESTNET_BYTE)) throw new Error('invalid_return_address');
  return { normalized: normalizeAddress(raw), pretty: prettyAddress(raw) };
}

/**
 * Reads the balance and the fee now and works out the amount to send: everything except the fee.
 * Symbol: the fee is the quoted maximum fee of a plain transfer. NEM: the fee depends on the amount and is
 * not higher for a smaller amount, so the fee of the whole balance covers the fee of what is actually sent.
 */
export async function planTestnetReturn(chain: ChainKey, address: string): Promise<TestnetReturnPlan> {
  // Never send test coins to a real-network address by mistake: only while the app is on the testnet.
  if (getNetwork() !== 'testnet' || NETWORKS.testnet.networkByte !== TESTNET_BYTE) throw new Error('not_testnet');
  const to = returnRecipient(chain);
  let balance: bigint;
  let fee: bigint;
  if (chain === 'nem') {
    balance = await fetchNemXemBalance(address);
    fee = nemTransferFee(balance, undefined);
  } else {
    const list = await fetchBalances(address);
    balance = list.find((b) => b.id.toUpperCase() === NETWORKS.testnet.currencyMosaicId.toUpperCase())?.amount ?? 0n;
    fee = (await quoteFee(1, undefined)).fee;
  }
  const amount = balance > fee ? balance - fee : 0n;
  return {
    chain,
    recipient: to.normalized,
    recipientPretty: to.pretty,
    balance,
    fee,
    amount,
    divisibility: DIVISIBILITY,
    symbol: chain === 'nem' ? 'XEM' : 'XYM',
  };
}

export interface TestnetReturnSigner {
  /** Ledger のアカウントなら空文字にして `ledgerIndex` を入れる。 */
  privateKey: string;
  ledgerIndex?: number;
  publicKey: string;
}

/**
 * Sends the whole balance (minus the fee) to the return address. The amount is worked out again right before
 * signing, so a fee that moved since the dialog opened cannot make the transfer fail for lack of balance.
 */
export async function executeTestnetReturn(chain: ChainKey, address: string, signer: TestnetReturnSigner): Promise<{ hash: string; plan: TestnetReturnPlan }> {
  const plan = await planTestnetReturn(chain, address);
  if (plan.amount <= 0n) throw new Error('nothing_to_return');
  if (chain === 'nem') {
    const { hash } = await sendNemTransfer({ ...signer, recipient: plan.recipient, amount: plan.amount });
    return { hash, plan };
  }
  const { hash } = await sendTransfer({
    ...signer,
    recipient: plan.recipient,
    mosaics: [{ id: NETWORKS.testnet.currencyMosaicId, amount: plan.amount }],
  });
  return { hash, plan };
}
