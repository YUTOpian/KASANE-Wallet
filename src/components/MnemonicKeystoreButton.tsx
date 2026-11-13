import { useMemo, useState } from 'react';
import KeystoreButton from './KeystoreButton';
import { getChain } from '../lib/chain';
import { MnemonicHelper, PROFILE_ACCOUNT_COUNT } from '../lib/symbol/hd';
import { nemAccountFromMnemonic } from '../lib/nem/hd';

interface Props {
  /** The recovery phrase on screen. Nothing is rendered until it is known (empty string). */
  mnemonic: string;
  /** Symbol testnet with the official-compatible keys (coin type 1); omit for 4343. */
  symbolCoinType?: number;
}

// 「キーストアをダウンロード」 for a recovery-phrase screen. A keystore holds ONE account's key, so the person
// picks which account of the phrase (the same ones the profile lists, 1..PROFILE_ACCOUNT_COUNT) goes into the file;
// the first account is preselected. The chain follows the one the app is working in, like the paper wallet.
// The key is derived on this device from the phrase already on screen; nothing is stored.
export default function MnemonicKeystoreButton({ mnemonic, symbolCoinType }: Props) {
  const [index, setIndex] = useState(0);
  const chain = getChain();

  const source = useMemo(() => {
    if (mnemonic.length === 0) return null;
    try {
      const pair = chain === 'nem'
        ? nemAccountFromMnemonic(mnemonic, index)
        : MnemonicHelper.accountFromMnemonic(mnemonic, index, symbolCoinType);
      return { chain, privateKey: pair.privateKey, publicKey: pair.publicKey };
    } catch {
      // A phrase that cannot be derived (should not happen on these screens): offer no keystore rather than a wrong one.
      return null;
    }
  }, [mnemonic, index, chain, symbolCoinType]);

  return (
    <KeystoreButton
      source={source}
      hintKey="wallet.keystore_hint_mnemonic"
      picker={{ index, count: PROFILE_ACCOUNT_COUNT, onChange: setIndex }}
    />
  );
}
