// Public facts about an account that the network knows: whether its public key is published, and its multisig role.
import { getChain } from './chain';
import { fetchAccountPublicKey, fetchMultisigInfo } from './symbol/multisigApi';
import { fetchNemMultisigInfo } from './nem/multisigApi';

export interface AccountStatus {
  /** Public key the network has on record; null = not published (the account has never signed a transaction). */
  networkPublicKey: string | null;
  isMultisig: boolean;
  /** Approvals needed (multisig accounts only). 0 on NEM means every cosigner must sign. */
  minApproval: number;
  cosignatoryCount: number;
  /** Number of multisig accounts this account cosigns for. */
  cosignerOfCount: number;
}

export async function fetchAccountStatus(address: string): Promise<AccountStatus> {
  if (getChain() === 'nem') {
    const m = await fetchNemMultisigInfo(address);
    return {
      networkPublicKey: m.publicKey,
      isMultisig: m.isMultisig,
      minApproval: m.minCosignatories,
      cosignatoryCount: m.cosignatories.length,
      cosignerOfCount: m.multisigOf.length,
    };
  }
  const [m, key] = await Promise.all([fetchMultisigInfo(address), fetchAccountPublicKey(address)]);
  return {
    networkPublicKey: key,
    isMultisig: m.isMultisig,
    minApproval: m.minApproval,
    cosignatoryCount: m.cosignatories.length,
    cosignerOfCount: m.multisigOf.length,
  };
}
