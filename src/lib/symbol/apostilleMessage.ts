// アポスティーユのメッセージの見分け方（Symbol）。api.ts（履歴の表示）と apostille.ts（作成・検証）の両方が使うので、ここに分けた。
import { APOSTILLE_PREFIX } from '../nem/apostille';

/** What the history shows instead of the message of an apostille transfer (its message is a hash or a signature, not text). */
export const APOSTILLE_MESSAGE_LABEL = '[Apostille]';

/**
 * The apostille message (hex, starting with fe4e5459) inside a transfer's message field (hex, as the node returns it:
 * the type byte 00 first). Empty when the transfer does not carry an apostille.
 */
export function apostilleHexFromMessageField(messageFieldHex: string | undefined): string {
  const hex = (messageFieldHex ?? '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0 || hex.length < 2) return '';
  if (hex.slice(0, 2) !== '00') return '';
  const rest = hex.slice(2);
  return rest.startsWith(APOSTILLE_PREFIX) ? rest : '';
}
