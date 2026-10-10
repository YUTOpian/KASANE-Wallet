// Helpers for Symbol metadata: scoped keys, value encoding, the XOR update rule and size maths.
// Nothing here talks to the network or the SDK, so it is safe to use from forms.
import { sha3_256 } from '@noble/hashes/sha3.js';

export type MetadataTargetType = 'account' | 'mosaic' | 'namespace';

/** The protocol's metadata type codes (used by the REST `metadataType` filter). */
export const METADATA_TYPE_CODE: Record<MetadataTargetType, number> = { account: 0, mosaic: 1, namespace: 2 };

export const MAX_METADATA_VALUE_BYTES = 1024;
/** How many key/value rows the creation / registration forms allow. */
export const MAX_METADATA_ENTRIES_AT_CREATION = 5;

// --- keys -------------------------------------------------------------------------------------

/**
 * Same rule as the official SDKs' metadataGenerateKey: the first 8 bytes of SHA3-256(text) read as
 * a little-endian uint64, with the top bit forced on.
 */
export function generateMetadataKey(text: string): bigint {
  const digest = sha3_256(new TextEncoder().encode(text));
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const lower = view.getUint32(0, true);
  const upper = (view.getUint32(4, true) | 0x80000000) >>> 0;
  return (BigInt(upper) << 32n) | BigInt(lower);
}

/** 16 hex chars -> used as the key as-is; anything else is hashed with generateMetadataKey. */
export function parseMetadataKey(input: string): bigint | null {
  const text = input.trim();
  if (text === '') return null;
  if (/^[0-9a-fA-F]{16}$/.test(text)) return BigInt(`0x${text}`);
  return generateMetadataKey(text);
}

export function keyToHex(key: bigint): string {
  return key.toString(16).toUpperCase().padStart(16, '0');
}

// --- values -----------------------------------------------------------------------------------

export function encodeValue(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 text when the bytes are printable text, otherwise null (callers then show hex). */
export function decodeValueText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * Symbol stores no "set value" operation: a change carries old XOR new (zero-padded to the longer
 * of the two) plus the signed size difference, and the network applies it to the stored value.
 */
export function xorValue(oldValue: Uint8Array, newValue: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(oldValue.length, newValue.length));
  for (let i = 0; i < out.length; i += 1) out[i] = (oldValue[i] ?? 0) ^ (newValue[i] ?? 0);
  return out;
}

// --- sizes (only used to show the fee before signing) -------------------------------------------

const pad8 = (n: number) => Math.ceil(n / 8) * 8;

/** Size of one embedded metadata transaction inside an aggregate (value = the XOR'd value's length). */
export function metadataEmbeddedSize(type: MetadataTargetType, valueLength: number): number {
  // 48 embedded header + target address 24 + key 8 + (target id 8 for mosaic / namespace)
  // + value size delta 2 + value size 2 + value.
  const body = 24 + 8 + (type === 'account' ? 0 : 8) + 2 + 2 + valueLength;
  return pad8(48 + body);
}

/** Aggregate: 128 common header + 40 aggregate body + the embedded transactions. */
export const AGGREGATE_BASE_SIZE = 168;

export function metadataAggregateSize(type: MetadataTargetType, valueLengths: number[]): number {
  return AGGREGATE_BASE_SIZE + valueLengths.reduce((sum, len) => sum + metadataEmbeddedSize(type, len), 0);
}

// --- drafts typed into the creation / registration forms ------------------------------------------

export interface MetadataDraft {
  id: number;
  key: string; // text or 16 hex chars
  value: string;
}

export type DraftError = 'key_required' | 'value_required' | 'value_too_long' | 'duplicate_key' | null;

const isBlank = (d: MetadataDraft) => d.key.trim() === '' && d.value === '';

/** Rows the user has actually filled in; completely empty rows are ignored. */
export function activeDrafts(drafts: MetadataDraft[]): MetadataDraft[] {
  return drafts.filter((d) => !isBlank(d));
}

/** One error (or null) per draft, in the same order. */
export function draftErrors(drafts: MetadataDraft[]): DraftError[] {
  const seen = new Set<string>();
  return drafts.map((d) => {
    if (isBlank(d)) return null;
    const key = parseMetadataKey(d.key);
    if (key === null) return 'key_required';
    if (d.value === '') return 'value_required';
    if (encodeValue(d.value).length > MAX_METADATA_VALUE_BYTES) return 'value_too_long';
    const hex = keyToHex(key);
    if (seen.has(hex)) return 'duplicate_key';
    seen.add(hex);
    return null;
  });
}

export function draftsValid(drafts: MetadataDraft[]): boolean {
  return draftErrors(drafts).every((e) => e === null);
}

export interface MetadataItem {
  key: bigint;
  value: Uint8Array;
}

/** Converts valid drafts into key/value items (call only when draftsValid). */
export function draftsToItems(drafts: MetadataDraft[]): MetadataItem[] {
  return activeDrafts(drafts).map((d) => ({ key: parseMetadataKey(d.key) as bigint, value: encodeValue(d.value) }));
}

/** Byte lengths of the filled-in drafts' values (for the fee estimate). */
export function draftValueLengths(drafts: MetadataDraft[]): number[] {
  return activeDrafts(drafts).map((d) => encodeValue(d.value).length);
}
