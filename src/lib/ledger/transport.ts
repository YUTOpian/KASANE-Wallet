// Ledger との接続（USB: WebHID / WebUSB、Bluetooth: Web Bluetooth）。
// 外部ライブラリは使わず、ブラウザのAPIを直接使う（フレーム分割は framing.ts）。
// ブラウザの対応:
//   WebHID       … PC の Chrome / Edge（Android は非対応）
//   WebUSB       … PC の Chrome / Edge、Android の Chrome（OTG ケーブル）
//   Bluetooth    … Chrome / Edge（PC・Android）。Nano X / Stax / Flex。iPhone の Safari は非対応
import {
  BleReassembler, HID_PACKET_SIZE, HidReassembler, LedgerError, bleWrap, hidWrap,
} from './framing';

export type TransportKind = 'hid' | 'usb' | 'ble';

export interface LedgerTransport {
  readonly kind: TransportKind;
  /** APDU を送り、応答（末尾のステータスワードを含む）を返す。 */
  exchange(apdu: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
  /** 切断されたときに呼ばれる。 */
  onDisconnect(handler: () => void): void;
}

export const LEDGER_VENDOR_ID = 0x2c97;

// 型定義（lib.dom に無いブラウザAPIを最小限だけ宣言する）
/* eslint-disable @typescript-eslint/no-explicit-any */
type Nav = any;
const nav = (): Nav => (typeof navigator === 'undefined' ? {} : (navigator as Nav));

export function supportedTransports(): Record<TransportKind, boolean> {
  const n = nav();
  const secure = typeof window === 'undefined' ? false : window.isSecureContext;
  return { hid: secure && !!n.hid, usb: secure && !!n.usb, ble: secure && !!n.bluetooth };
}

// 1つの接続で同時に2つの操作をしない
function withLock<T>(state: { busy: boolean }, run: () => Promise<T>): Promise<T> {
  if (state.busy) return Promise.reject(new LedgerError('busy'));
  state.busy = true;
  return run().finally(() => { state.busy = false; });
}

function pickNotAllowed(e: unknown): never {
  const name = (e as { name?: string })?.name;
  if (name === 'NotFoundError' || name === 'NotAllowedError' || name === 'AbortError') throw new LedgerError('no_device');
  throw e instanceof LedgerError ? e : new LedgerError('disconnected', (e as Error)?.message ?? '');
}

// ---- WebHID ----------------------------------------------------------------------------------
class HidTransport implements LedgerTransport {
  readonly kind = 'hid' as const;
  private state = { busy: false };
  private disconnectHandlers: Array<() => void> = [];
  private device: any;
  constructor(device: any) {
    this.device = device;
    nav().hid.addEventListener('disconnect', (ev: any) => {
      if (ev.device === this.device) this.disconnectHandlers.forEach((h) => h());
    });
  }
  onDisconnect(h: () => void) { this.disconnectHandlers.push(h); }

  exchange(apdu: Uint8Array): Promise<Uint8Array> {
    return withLock(this.state, () => new Promise<Uint8Array>((resolve, reject) => {
      const re = new HidReassembler();
      const onReport = (ev: any) => {
        try {
          const done = re.push(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
          if (done) { this.device.removeEventListener('inputreport', onReport); resolve(done); }
        } catch (e) { this.device.removeEventListener('inputreport', onReport); reject(e); }
      };
      this.device.addEventListener('inputreport', onReport);
      (async () => {
        for (const packet of hidWrap(apdu)) await this.device.sendReport(0, packet);
      })().catch((e) => { this.device.removeEventListener('inputreport', onReport); reject(new LedgerError('disconnected', (e as Error).message)); });
    }));
  }
  async close() { try { await this.device.close(); } catch { /* 既に閉じている */ } }
}

async function openHid(): Promise<LedgerTransport> {
  let found: any;
  try {
    found = await nav().hid.requestDevice({ filters: [{ vendorId: LEDGER_VENDOR_ID }] });
  } catch (e) { return pickNotAllowed(e); }
  const device = found?.[0];
  if (!device) throw new LedgerError('no_device');
  // ここから先の失敗は「選んだのに開けない」（別のアプリが使っている等）。選択を閉じたこと（no_device）とは区別する。
  try {
    if (!device.opened) await device.open();
  } catch (e) { throw new LedgerError('in_use', (e as Error)?.message ?? ''); }
  return new HidTransport(device);
}

// ---- WebUSB ----------------------------------------------------------------------------------
class UsbTransport implements LedgerTransport {
  readonly kind = 'usb' as const;
  private state = { busy: false };
  private disconnectHandlers: Array<() => void> = [];
  private device: any;
  private iface: number;
  private epIn: number;
  private epOut: number;
  constructor(device: any, iface: number, epIn: number, epOut: number) {
    this.device = device;
    this.iface = iface;
    this.epIn = epIn;
    this.epOut = epOut;
    nav().usb.addEventListener('disconnect', (ev: any) => {
      if (ev.device === this.device) this.disconnectHandlers.forEach((h) => h());
    });
  }
  onDisconnect(h: () => void) { this.disconnectHandlers.push(h); }

  exchange(apdu: Uint8Array): Promise<Uint8Array> {
    return withLock(this.state, async () => {
      try {
        for (const packet of hidWrap(apdu)) await this.device.transferOut(this.epOut, packet);
        const re = new HidReassembler();
        for (;;) {
          const res = await this.device.transferIn(this.epIn, HID_PACKET_SIZE);
          if (res.status !== 'ok' || !res.data) throw new LedgerError('disconnected', 'usb_status');
          const done = re.push(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
          if (done) return done;
        }
      } catch (e) {
        throw e instanceof LedgerError ? e : new LedgerError('disconnected', (e as Error).message);
      }
    });
  }
  async close() {
    try { await this.device.releaseInterface(this.iface); await this.device.close(); } catch { /* 既に閉じている */ }
  }
}

async function openUsb(): Promise<LedgerTransport> {
  let device: any;
  try {
    device = await nav().usb.requestDevice({ filters: [{ vendorId: LEDGER_VENDOR_ID }] });
  } catch (e) { return pickNotAllowed(e); }
  if (!device) throw new LedgerError('no_device');
  // ここから先の失敗は「選んだのに開けない」（別のアプリ・ドライバが使っている等）。
  try {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    // ベンダー固有クラス(0xff)のインターフェースを探し、その入出力エンドポイントを使う
    let found: { iface: number; epIn: number; epOut: number } | null = null;
    for (const iface of device.configuration.interfaces) {
      const alt = iface.alternates.find((a: any) => a.interfaceClass === 0xff);
      if (!alt) continue;
      const epIn = alt.endpoints.find((e: any) => e.direction === 'in' && e.type === 'interrupt')
        ?? alt.endpoints.find((e: any) => e.direction === 'in');
      const epOut = alt.endpoints.find((e: any) => e.direction === 'out' && e.type === 'interrupt')
        ?? alt.endpoints.find((e: any) => e.direction === 'out');
      if (epIn && epOut) { found = { iface: iface.interfaceNumber, epIn: epIn.endpointNumber, epOut: epOut.endpointNumber }; break; }
    }
    if (!found) throw new LedgerError('bad_response', 'usb_interface');
    try { await device.reset(); } catch { /* 無くても続ける */ }
    await device.claimInterface(found.iface);
    return new UsbTransport(device, found.iface, found.epIn, found.epOut);
  } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError('in_use', (e as Error)?.message ?? '');
  }
}

// ---- Web Bluetooth ---------------------------------------------------------------------------
// 機種ごとのサービス UUID（書き込み・通知の UUID は末尾付近の番号だけが違う）
const BLE_SERVICES = [
  '13d63400-2c97-0004-0000-4c6564676572', // Nano X
  '13d63400-2c97-6004-0000-4c6564676572', // Stax
  '13d63400-2c97-3004-0000-4c6564676572', // Flex
];
const bleUuid = (service: string, n: number) => service.replace('-0000-4c65', `-000${n}-4c65`);

class BleTransport implements LedgerTransport {
  readonly kind = 'ble' as const;
  private state = { busy: false };
  private disconnectHandlers: Array<() => void> = [];
  private re = new BleReassembler();
  private waiter: { resolve: (v: Uint8Array) => void; reject: (e: unknown) => void; raw?: boolean } | null = null;
  private device: any;
  private write: any;
  private chunkSize: number;
  constructor(device: any, write: any, notify: any, chunkSize: number) {
    this.device = device;
    this.write = write;
    this.chunkSize = chunkSize;
    notify.addEventListener('characteristicvaluechanged', (ev: any) => {
      const v: DataView = ev.target.value;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const w = this.waiter;
      if (!w) return;
      try {
        if (w.raw) { this.waiter = null; w.resolve(bytes.slice()); return; }
        const done = this.re.push(bytes);
        if (done) { this.waiter = null; w.resolve(done); }
      } catch (e) { this.waiter = null; this.re.reset(); w.reject(e); }
    });
    device.addEventListener('gattserverdisconnected', () => this.disconnectHandlers.forEach((h) => h()));
  }
  onDisconnect(h: () => void) { this.disconnectHandlers.push(h); }

  static async negotiateMtu(t: { write: any; notify: any }): Promise<number> {
    // 0x08 コマンドでデバイスの MTU を聞く。応答: [0x08, 0, 0, 0, 0, mtu]
    const reply = await new Promise<Uint8Array>((resolve, reject) => {
      const onChange = (ev: any) => {
        t.notify.removeEventListener('characteristicvaluechanged', onChange);
        const v: DataView = ev.target.value;
        resolve(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
      };
      t.notify.addEventListener('characteristicvaluechanged', onChange);
      t.write.writeValueWithResponse(Uint8Array.from([0x08, 0, 0, 0, 0])).catch(reject);
    });
    if (reply.length < 6 || reply[0] !== 0x08) throw new LedgerError('bad_response', 'mtu');
    return Math.max(20, reply[5] - 3);
  }

  exchange(apdu: Uint8Array): Promise<Uint8Array> {
    return withLock(this.state, () => new Promise<Uint8Array>((resolve, reject) => {
      this.re.reset();
      this.waiter = { resolve, reject };
      (async () => {
        for (const packet of bleWrap(apdu, this.chunkSize)) await this.write.writeValueWithResponse(packet);
      })().catch((e) => { this.waiter = null; reject(new LedgerError('disconnected', (e as Error).message)); });
    }));
  }
  async close() { try { this.device.gatt?.disconnect(); } catch { /* 既に切れている */ } }
}

async function openBle(): Promise<LedgerTransport> {
  try {
    const device = await nav().bluetooth.requestDevice({ filters: BLE_SERVICES.map((s) => ({ services: [s] })), optionalServices: BLE_SERVICES });
    const server = await device.gatt.connect();
    let service: any = null;
    let uuid = '';
    for (const candidate of BLE_SERVICES) {
      try { service = await server.getPrimaryService(candidate); uuid = candidate; break; } catch { /* 次の機種へ */ }
    }
    if (!service) throw new LedgerError('bad_response', 'ble_service');
    const notify = await service.getCharacteristic(bleUuid(uuid, 1));
    const write = await service.getCharacteristic(bleUuid(uuid, 2));
    await notify.startNotifications();
    const chunkSize = await BleTransport.negotiateMtu({ write, notify });
    return new BleTransport(device, write, notify, chunkSize);
  } catch (e) { return pickNotAllowed(e); }
}

export async function openTransport(kind: TransportKind): Promise<LedgerTransport> {
  if (!supportedTransports()[kind]) throw new LedgerError('unsupported_browser', kind);
  if (kind === 'hid') return openHid();
  if (kind === 'usb') return openUsb();
  return openBle();
}

// ---- 画面に出す「つなぎ方」（USBケーブル / Bluetooth） ---------------------------------------
// 画面では「USBケーブル」と「Bluetooth」だけを見せる。USBケーブルの中で WebHID と WebUSB のどちらを使うかは、
// ここで自動で決める（WebHID を先に試し、開けなければ WebUSB。Android は WebHID が無いので WebUSB だけ）。
export type LinkKind = 'cable' | 'ble';

export function supportedLinks(): LinkKind[] {
  const s = supportedTransports();
  const out: LinkKind[] = [];
  if (s.hid || s.usb) out.push('cable');
  if (s.ble) out.push('ble');
  return out;
}

const GOOD_KEY = 'kasane_ledger_transport'; // 前回うまくつながった USB の方式
const FAILED_KEY = 'kasane_ledger_usb_failed'; // 前回「開けなかった」USB の方式（次は後回しにする）

function readKey(key: string): TransportKind | null {
  try {
    const v = localStorage.getItem(key);
    return v === 'hid' || v === 'usb' ? v : null;
  } catch { return null; }
}
function writeKey(key: string, value: TransportKind | null) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* 保存できない環境 */ }
}

/**
 * USB の方式を試す順番。基本は WebHID → WebUSB。前回うまくいった方式があれば先頭に、
 * 前回開けなかった方式（もう一方が使えるとき）は後ろにする。使えない方式は入れない。
 */
export function usbTryOrder(supported: Pick<Record<TransportKind, boolean>, 'hid' | 'usb'>, good: TransportKind | null, failed: TransportKind | null): Array<'hid' | 'usb'> {
  let order = (['hid', 'usb'] as const).filter((k) => supported[k]);
  if (good === 'hid' || good === 'usb') order = [...order].sort((a, b) => (a === good ? -1 : b === good ? 1 : 0));
  if (order.length > 1 && (failed === 'hid' || failed === 'usb') && failed !== good) order = [...order].sort((a, b) => (a === failed ? 1 : b === failed ? -1 : 0));
  return order;
}

/**
 * 順番に試して、最初にひらけたものを返す。
 * 選ぶ画面を閉じた（no_device）ときは、すぐ止める（もう一度ほかの方式の選ぶ画面を出さない）。
 * 開けなかったとき（別のアプリが使っている等）だけ、次の方式を試す。全部だめなら、最初のエラーを返す。
 */
export async function openCable(
  order: Array<'hid' | 'usb'>,
  opener: (kind: TransportKind) => Promise<LedgerTransport>,
  onFailed?: (kind: 'hid' | 'usb') => void,
): Promise<LedgerTransport> {
  if (order.length === 0) throw new LedgerError('unsupported_browser', 'usb');
  let first: unknown = null;
  for (const kind of order) {
    try {
      return await opener(kind);
    } catch (e) {
      if (e instanceof LedgerError && e.kind === 'no_device') throw e;
      onFailed?.(kind);
      if (first === null) first = e;
    }
  }
  throw first;
}

export async function openLink(link: LinkKind): Promise<LedgerTransport> {
  if (link === 'ble') return openTransport('ble');
  const order = usbTryOrder(supportedTransports(), readKey(GOOD_KEY), readKey(FAILED_KEY));
  const t = await openCable(order, openTransport, (k) => writeKey(FAILED_KEY, k));
  writeKey(GOOD_KEY, t.kind);
  writeKey(FAILED_KEY, null);
  return t;
}
