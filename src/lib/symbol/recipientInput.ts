// What a typed recipient can be besides a plain address: a namespace alias ("nem.group", "@nem.group")
// or a 64-hex public key. Pure parsing only; the lookups live in api.ts (resolveRecipientInput).
import { generateNamespaceId } from 'symbol-sdk/symbol';

export type RecipientInput =
  | { kind: 'alias'; name: string }
  | { kind: 'publicKey'; publicKey: string }
  | { kind: 'other' };

// One namespace label: lower-case letters, digits, '_' and '-', 1-64 chars (Symbol's rule).
const LABEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DEPTH = 3;

/** Namespace labels of a typed name, or null when it is not a well-formed namespace name. */
export function namespaceLabels(name: string): string[] | null {
  const labels = name.split('.');
  if (labels.length < 1 || labels.length > MAX_DEPTH) return null;
  return labels.every((l) => LABEL.test(l)) ? labels : null;
}

/**
 * An alias needs a dot ("nem.group") or a leading "@" ("@nem"): a bare lower-case word is more
 * likely a mistyped address than a root namespace, so it stays an address error.
 */
export function classifyRecipientInput(raw: string): RecipientInput {
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return { kind: 'publicKey', publicKey: text.toUpperCase() };
  const hasAt = text.startsWith('@');
  const name = (hasAt ? text.slice(1) : text).toLowerCase();
  if ((hasAt || name.includes('.')) && namespaceLabels(name) !== null) return { kind: 'alias', name };
  return { kind: 'other' };
}

/** Namespace id of each level of the name ("a.b.c" -> ids of a, a.b, a.b.c), 16 upper-case hex chars. */
export function namespaceIdPath(labels: string[]): string[] {
  const ids: string[] = [];
  let parent = 0n;
  for (const label of labels) {
    parent = BigInt(generateNamespaceId(label, parent));
    ids.push(parent.toString(16).toUpperCase().padStart(16, '0'));
  }
  return ids;
}
