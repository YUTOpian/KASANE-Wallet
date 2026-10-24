// An address on a restriction list typed as a namespace alias ("nem.group" or "@nem.group"). The alias is looked up
// once, here, and the REAL address it points to goes on the list - the same way the send form treats a typed alias.
// A restriction therefore never depends on who owns or re-links the name later, and the confirm screen can show
// the address that will actually be listed.
import { classifyRecipientInput } from './recipientInput';
import type { RecipientInput } from './recipientInput';
import { parseRestrictionInput } from './restrictions';
import type { RestrictionInputError } from './restrictions';
import type { RecipientResolution } from './api';

export type RestrictionAddressResult =
  | { ok: true; value: string; /** the alias the user typed, when there was one */ alias?: string }
  | { ok: false; error: RestrictionInputError };

export interface RestrictionAddressOptions {
  networkByte?: number;
  /** The account being restricted (for a multisig account: the multisig account, not the wallet). */
  ownAddress?: string;
}

/** The resolver is passed in (api.ts resolveRecipientInput) so this file stays free of network code. */
export type AliasResolver = (input: RecipientInput, networkByte: number) => Promise<RecipientResolution>;

const REASON_TO_ERROR: Record<Extract<RecipientResolution, { ok: false }>['reason'], RestrictionInputError> = {
  not_found: 'alias_not_found',
  no_address_alias: 'alias_no_address',
  expired: 'alias_expired',
  wrong_network: 'alias_wrong_network',
  invalid: 'invalid_address',
};

/**
 * Turns what was typed into a listable address: a real address is checked as before, an alias is resolved first and the
 * resulting address is checked the same way (network, not the account itself). A public key is not accepted here.
 */
export async function parseRestrictionAddressInput(
  raw: string,
  opts: RestrictionAddressOptions,
  resolve: AliasResolver,
): Promise<RestrictionAddressResult> {
  const classified = classifyRecipientInput(raw);
  if (classified.kind !== 'alias') {
    const parsed = parseRestrictionInput('address', raw, opts);
    return parsed.ok ? { ok: true, value: parsed.value } : parsed;
  }
  if (opts.networkByte === undefined) return { ok: false, error: 'alias_lookup_failed' };
  let resolution: RecipientResolution;
  try {
    resolution = await resolve(classified, opts.networkByte);
  } catch {
    return { ok: false, error: 'alias_lookup_failed' };
  }
  if (!resolution.ok) return { ok: false, error: REASON_TO_ERROR[resolution.reason] };
  const parsed = parseRestrictionInput('address', resolution.address, opts);
  return parsed.ok ? { ok: true, value: parsed.value, alias: classified.name } : parsed;
}
