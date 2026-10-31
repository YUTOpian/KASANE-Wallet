import type { ChainKey } from './chain';
import { prettyAddress } from './symbol/crypto';
import { prettyNemAddress } from './nem/crypto';

/** チェーンを指定して、アドレスを6文字ごとのハイフン区切りにする（現在のチェーンに依存しない版）。 */
export function prettyChainAddressOf(chain: ChainKey, address: string): string {
  return chain === 'nem' ? prettyNemAddress(address) : prettyAddress(address);
}
