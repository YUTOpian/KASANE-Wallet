// Namespace names for the history: an address that has a namespace alias is shown by that name, and a transfer sent to
// an alias ("@<hex id>" in the history data) by the alias's full name. Both lookups are batched and cached per network.
import { addressBytesToString, bytesToHex, hexToBytes, normalizeAddress } from './crypto';
import { getNetwork } from './network';
import { nodeRequest } from './api';

const CHUNK = 50;
const JSON_POST = { method: 'POST', headers: { 'Content-Type': 'application/json' } } as const;

// network -> plain address -> first alias name ('' = looked up, none)
const addressCache = new Map<string, Map<string, string>>();
// network -> namespace id (upper hex) -> full name ('' = looked up, unknown)
const idCache = new Map<string, Map<string, string>>();

function cacheFor(store: Map<string, Map<string, string>>): Map<string, string> {
  const key = getNetwork();
  let c = store.get(key);
  if (!c) { c = new Map(); store.set(key, c); }
  return c;
}

const chunks = <T,>(list: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

/**
 * The namespace id candidates of a history recipient "@<hex>". The history shows the 8 id bytes in the order they sit in
 * the transaction (little endian) while the REST API writes ids big endian, so the reversed bytes come first; the
 * unchanged hex is tried too, in case the data is already big endian.
 */
export function aliasIdCandidates(recipient: string): string[] {
  const hex = recipient.replace(/^@/, '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(hex)) return [];
  const reversed = bytesToHex(hexToBytes(hex).reverse()).toUpperCase();
  return reversed === hex ? [hex] : [reversed, hex];
}

/** Full names ("root.child") of namespace ids; an id the node does not know is left out. */
async function fetchNamespaceNames(ids: string[]): Promise<Record<string, string>> {
  const cache = cacheFor(idCache);
  const wanted = [...new Set(ids.map((i) => i.toUpperCase()))].filter((i) => !cache.has(i));
  const parents = new Map<string, string>();
  const own = new Map<string, string>();
  let todo = wanted;
  // A child's name is "parent.child": walk up (a namespace has at most three levels).
  for (let round = 0; round < 3 && todo.length > 0; round += 1) {
    const next: string[] = [];
    for (const part of chunks(todo)) {
      let res: Array<{ id: string; name: string; parentId?: string }> = [];
      try {
        res = await nodeRequest<Array<{ id: string; name: string; parentId?: string }>>('/namespaces/names', { ...JSON_POST, body: JSON.stringify({ namespaceIds: part }) });
      } catch (e) {
        console.warn('Could not look up namespace names', e);
      }
      for (const n of res) {
        const id = n.id.toUpperCase();
        own.set(id, n.name);
        const parent = n.parentId?.toUpperCase();
        if (parent && !/^0+$/.test(parent)) {
          parents.set(id, parent);
          if (!own.has(parent) && !next.includes(parent)) next.push(parent);
        }
      }
    }
    todo = next;
  }
  const full = (id: string, depth = 0): string => {
    const name = own.get(id);
    if (name === undefined) return '';
    const parent = parents.get(id);
    if (!parent || depth > 3) return name;
    const head = full(parent, depth + 1);
    return head ? `${head}.${name}` : '';
  };
  for (const id of wanted) cache.set(id, full(id));
  const out: Record<string, string> = {};
  for (const id of ids) {
    const name = cache.get(id.toUpperCase());
    if (name) out[id.toUpperCase()] = name;
  }
  return out;
}

/** Namespace names for recipients written "@<hex>": recipient -> full name (without "@"). Unknown ones are left out. */
export async function resolveAliasRecipients(recipients: string[]): Promise<Record<string, string>> {
  const candidates = recipients.flatMap((r) => aliasIdCandidates(r));
  if (candidates.length === 0) return {};
  const names = await fetchNamespaceNames(candidates);
  const out: Record<string, string> = {};
  for (const r of recipients) {
    const hit = aliasIdCandidates(r).map((id) => names[id]).find(Boolean);
    if (hit) out[r] = hit;
  }
  return out;
}

/** The first namespace alias of each address: plain address -> full namespace name. Addresses without an alias are left out. */
export async function fetchAddressAliasNames(addresses: string[]): Promise<Record<string, string>> {
  const cache = cacheFor(addressCache);
  const plain = [...new Set(addresses.map((a) => normalizeAddress(a)))];
  const wanted = plain.filter((a) => !cache.has(a));
  for (const part of chunks(wanted)) {
    try {
      const res = await nodeRequest<{ accountNames?: Array<{ address: string; names: string[] }> }>('/namespaces/account/names', { ...JSON_POST, body: JSON.stringify({ addresses: part }) });
      const found = new Set<string>();
      for (const row of res.accountNames ?? []) {
        const address = normalizeAddress(addressBytesToString(hexToBytes(row.address)));
        found.add(address);
        cache.set(address, row.names?.[0] ?? '');
      }
      for (const a of part) if (!found.has(a)) cache.set(a, '');
    } catch (e) {
      console.warn('Could not look up address aliases', e); // not cached: tried again next time
    }
  }
  const out: Record<string, string> = {};
  for (const a of plain) {
    const name = cache.get(a);
    if (name) out[a] = name;
  }
  return out;
}
