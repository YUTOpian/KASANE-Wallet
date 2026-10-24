// Ledger との通信で使う、通信路に依存しない部品（APDU・フレーム分割・パス・ステータス）。
// ここは純粋な計算だけ（実機なしでテストできる）: dev-tests/ledger-framing.test.ts

// ---- APDU ----------------------------------------------------------------------------------
export const MAX_APDU_DATA = 255;

export function buildApdu(cla: number, ins: number, p1: number, p2: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (data.length > MAX_APDU_DATA) throw new Error('apdu_data_too_long');
  const out = new Uint8Array(5 + data.length);
  out.set([cla, ins, p1, p2, data.length], 0);
  out.set(data, 5);
  return out;
}

/** 応答の末尾2バイトがステータスワード。 */
export function splitStatus(response: Uint8Array): { data: Uint8Array; sw: number } {
  if (response.length < 2) throw new LedgerError('bad_response');
  const sw = (response[response.length - 2] << 8) | response[response.length - 1];
  return { data: response.slice(0, response.length - 2), sw };
}

export type LedgerErrorKind =
  | 'unsupported_browser'   // この端末・ブラウザでは使えない通信方式
  | 'no_device'             // デバイスが選ばれなかった／見つからない
  | 'disconnected'          // 通信の途中で切れた
  | 'in_use'                // デバイスは見つかったが開けない（Ledger Live など別のアプリが使っている等）
  | 'locked'                // デバイスがロック中
  | 'app_not_open'          // Symbol / NEM アプリが開かれていない
  | 'rejected'              // デバイスで拒否された
  | 'unsupported_tx'        // アプリがこの種類のトランザクションに対応していない
  | 'bad_response'          // 応答が想定と違う
  | 'key_mismatch'          // デバイスの鍵が、このアカウントの公開鍵と違う
  | 'busy'                  // 別の操作が進行中
  | 'unknown';

export class LedgerError extends Error {
  kind: LedgerErrorKind;
  detail: string;
  constructor(kind: LedgerErrorKind, detail = '') {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.detail = detail;
    this.name = 'LedgerError';
  }
}

export const SW_OK = 0x9000;

/** ステータスワード → エラー種別（OK のときは null）。 */
export function classifyStatus(sw: number): LedgerErrorKind | null {
  if (sw === SW_OK) return null;
  if (sw === 0x6985 || sw === 0x6986) return 'rejected';
  if (sw === 0x5515 || sw === 0x6b0c || sw === 0x6804) return 'locked';
  // CLA / INS が分からない = 別のアプリ（またはホーム画面）が開いている
  if (sw === 0x6e00 || sw === 0x6e01 || sw === 0x6d00 || sw === 0x6511) return 'app_not_open';
  if (sw === 0x6a80 || sw === 0x6984 || sw === 0x6a82) return 'unsupported_tx';
  return 'unknown';
}

export function statusHex(sw: number): string {
  return `0x${sw.toString(16).padStart(4, '0')}`;
}

// ---- BIP32 パス ----------------------------------------------------------------------------
const HARDENED = 0x80000000;

/** "m/44'/4343'/0'/0'/0'" → 数値の配列。 */
export function parsePath(path: string): number[] {
  const parts = path.replace(/^m\//, '').split('/');
  if (parts.length === 0 || parts.length > 10) throw new Error('bad_path');
  return parts.map((p) => {
    const hardened = p.endsWith("'") || p.endsWith('h');
    const n = Number(hardened ? p.slice(0, -1) : p);
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error('bad_path');
    return (hardened ? n + HARDENED : n) >>> 0;
  });
}

/** [本数][4バイト大端 × 本数]。 */
export function serializePath(path: string): Uint8Array {
  const nums = parsePath(path);
  const out = new Uint8Array(1 + nums.length * 4);
  out[0] = nums.length;
  const view = new DataView(out.buffer);
  nums.forEach((n, i) => view.setUint32(1 + i * 4, n, false));
  return out;
}

// ---- 分割送信 ------------------------------------------------------------------------------
/**
 * 先頭のまとまりに prefix（パスなど）を付け、残りを MAX_APDU_DATA ずつに分ける。
 * 返す配列の要素が、そのまま各 APDU のデータ部になる。
 */
export function chunkPayload(prefix: Uint8Array, payload: Uint8Array, max = MAX_APDU_DATA): Uint8Array[] {
  if (prefix.length >= max) throw new Error('prefix_too_long');
  const first = new Uint8Array(Math.min(max, prefix.length + payload.length));
  first.set(prefix, 0);
  const firstTake = first.length - prefix.length;
  first.set(payload.subarray(0, firstTake), prefix.length);
  const chunks = [first];
  for (let at = firstTake; at < payload.length; at += max) {
    chunks.push(payload.slice(at, Math.min(payload.length, at + max)));
  }
  return chunks;
}

// ---- HID / USB のフレーム（64バイト） ------------------------------------------------------
export const HID_CHANNEL = 0x0101;
export const HID_TAG = 0x05;
export const HID_PACKET_SIZE = 64;

export function hidWrap(apdu: Uint8Array, packetSize = HID_PACKET_SIZE): Uint8Array[] {
  const header = 5; // channel 2 + tag 1 + seq 2
  const packets: Uint8Array[] = [];
  const framed = new Uint8Array(2 + apdu.length); // 先頭に長さ(2)
  framed[0] = (apdu.length >> 8) & 0xff;
  framed[1] = apdu.length & 0xff;
  framed.set(apdu, 2);
  for (let seq = 0, at = 0; at < framed.length; seq += 1) {
    const packet = new Uint8Array(packetSize);
    packet[0] = (HID_CHANNEL >> 8) & 0xff;
    packet[1] = HID_CHANNEL & 0xff;
    packet[2] = HID_TAG;
    packet[3] = (seq >> 8) & 0xff;
    packet[4] = seq & 0xff;
    const take = Math.min(packetSize - header, framed.length - at);
    packet.set(framed.subarray(at, at + take), header);
    at += take;
    packets.push(packet);
  }
  return packets;
}

/** 受け取ったパケットを順に入れ、応答が揃ったら返す。 */
export class HidReassembler {
  private expected = -1;
  private seq = 0;
  private buffer: number[] = [];

  push(packet: Uint8Array): Uint8Array | null {
    if (packet.length < 5 || packet[2] !== HID_TAG) throw new LedgerError('bad_response', 'tag');
    const seq = (packet[3] << 8) | packet[4];
    if (seq !== this.seq) throw new LedgerError('bad_response', 'seq');
    let body: Uint8Array;
    if (seq === 0) {
      this.expected = (packet[5] << 8) | packet[6];
      body = packet.subarray(7);
    } else {
      body = packet.subarray(5);
    }
    this.seq += 1;
    for (const b of body) this.buffer.push(b);
    if (this.buffer.length >= this.expected) {
      const out = Uint8Array.from(this.buffer.slice(0, this.expected));
      this.reset();
      return out;
    }
    return null;
  }

  reset(): void {
    this.expected = -1;
    this.seq = 0;
    this.buffer = [];
  }
}

// ---- Bluetooth のフレーム（MTU に合わせて分割） --------------------------------------------
export const BLE_TAG = 0x05;

/** chunkSize = 1回に送れるバイト数（MTU − 3）。 */
export function bleWrap(apdu: Uint8Array, chunkSize: number): Uint8Array[] {
  if (chunkSize < 8) throw new Error('chunk_too_small');
  const packets: Uint8Array[] = [];
  let at = 0;
  for (let seq = 0; at < apdu.length || seq === 0; seq += 1) {
    const header = seq === 0 ? 5 : 3;
    const take = Math.min(chunkSize - header, apdu.length - at);
    const packet = new Uint8Array(header + take);
    packet[0] = BLE_TAG;
    packet[1] = (seq >> 8) & 0xff;
    packet[2] = seq & 0xff;
    if (seq === 0) {
      packet[3] = (apdu.length >> 8) & 0xff;
      packet[4] = apdu.length & 0xff;
    }
    packet.set(apdu.subarray(at, at + take), header);
    at += take;
    packets.push(packet);
  }
  return packets;
}

export class BleReassembler {
  private expected = -1;
  private seq = 0;
  private buffer: number[] = [];

  push(packet: Uint8Array): Uint8Array | null {
    if (packet.length < 3 || packet[0] !== BLE_TAG) throw new LedgerError('bad_response', 'tag');
    const seq = (packet[1] << 8) | packet[2];
    if (seq !== this.seq) throw new LedgerError('bad_response', 'seq');
    let body: Uint8Array;
    if (seq === 0) {
      if (packet.length < 5) throw new LedgerError('bad_response', 'short');
      this.expected = (packet[3] << 8) | packet[4];
      body = packet.subarray(5);
    } else {
      body = packet.subarray(3);
    }
    this.seq += 1;
    for (const b of body) this.buffer.push(b);
    if (this.buffer.length >= this.expected) {
      const out = Uint8Array.from(this.buffer.slice(0, this.expected));
      this.reset();
      return out;
    }
    return null;
  }

  reset(): void {
    this.expected = -1;
    this.seq = 0;
    this.buffer = [];
  }
}
