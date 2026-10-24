// Paper wallet export: turns the secret the screen already holds (recovery phrase or private key)
// into the QR codes + printable PDF of lib/paperWallet.ts and hands it to the person as a download.
// Everything happens on this device; nothing is uploaded and nothing is written to storage.
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { QRCodeCanvas } from 'qrcode.react';
import markUrl from '../assets/kasane_mark.png';
import { Environment } from './environment';
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { buildNemAddressQr } from './nem/qr';
import { nemAddressFromPublicKey } from './nem/crypto';
import { nemAccountFromMnemonic, nemPath } from './nem/hd';
import { addressFromPublicKey } from './symbol/crypto';
import { MnemonicHelper, symbolPath } from './symbol/hd';
import { getNetwork, getNetworkConfig } from './symbol/network';
import { buildPaperWalletPdf } from './paperWallet';
import type { PaperWalletInput } from './paperWallet';

// Symbol QR v3 type numbers, as in the official symbol-qr-library (the one the official wallets
// and their paper wallets use): 1 = contact (public key), 2 = account (private key), 5 = mnemonic.
const QR_TYPE_CONTACT = 1;
const QR_TYPE_ACCOUNT = 2;
const QR_TYPE_MNEMONIC = 5;

function symbolQr(type: number, data: Record<string, string>): string {
  const cfg = getNetworkConfig();
  return JSON.stringify({ v: 3, type, network_id: cfg.networkByte, chain_id: cfg.generationHash, data });
}

function hasDarkPixel(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0 && data[i] < 100) return true;
  }
  return false;
}

/** Draws `value` as a QR code on an off-screen canvas and returns it as PNG bytes. */
export async function qrToPng(value: string, opts: { level?: 'L' | 'M' | 'Q' | 'H'; size?: number } = {}): Promise<Uint8Array> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(createElement(QRCodeCanvas, { value, size: opts.size ?? 560, level: opts.level ?? 'M', marginSize: 2, bgColor: '#ffffff', fgColor: '#000000' }));
    });
    // qrcode.react paints in an effect; give any still-pending effect a turn before reading the canvas.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const canvas = host.querySelector('canvas');
    if (!canvas) throw new Error('paper wallet: QR canvas was not created');
    // A QR that was never painted would silently print as a blank square - refuse to go on.
    if (!hasDarkPixel(canvas)) throw new Error('paper wallet: QR canvas is blank');
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('paper wallet: QR image could not be encoded');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    root.unmount();
    host.remove();
  }
}

/** The KASANE mark is bundled as an asset - a data: URL in the single-file build. */
export async function loadMark(): Promise<Uint8Array> {
  const match = /^data:[^;,]*;base64,(.*)$/.exec(markUrl);
  if (match) {
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(await (await fetch(markUrl)).arrayBuffer());
}

export function addressOf(chain: ChainKey, publicKey: string): string {
  const networkByte = getNetworkConfig().networkByte;
  return chain === 'nem' ? nemAddressFromPublicKey(publicKey, networkByte) : addressFromPublicKey(publicKey, networkByte);
}

export async function saveFile(bytes: Uint8Array, filename: string, mime = 'application/pdf'): Promise<void> {
  // iOS (especially the home-screen app) ignores <a download>; hand the file to the share sheet instead.
  if (Environment.isIos() && typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
    const file = new File([bytes as BlobPart], filename, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
      } catch (e) {
        // Closing the share sheet is not an error.
        if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
      }
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function stamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

export type PaperWalletSource =
  // chain: 省略するとアプリで選んでいるチェーン。Symbol オプトイン（デモ）は Symbol で固定して作る。
  // symbolCoinType: Symbol のテストネットで公式互換の鍵（コイン種別 1）を使っているときに渡す。省略は 4343。
  | { kind: 'mnemonic'; mnemonic: string; chain?: ChainKey; symbolCoinType?: number }
  | { kind: 'key'; chain: ChainKey; privateKey: string; publicKey: string };

/** Builds the paper wallet PDF for the given secret. */
export async function createPaperWalletPdf(source: PaperWalletSource, now: Date = new Date()): Promise<{ bytes: Uint8Array; filename: string }> {
  const network = getNetwork();
  const markPng = await loadMark();
  let input: PaperWalletInput;

  if (source.kind === 'mnemonic') {
    // The phrase is shared by both chains; the sheet follows the chain the person is working in
    // (the same rule the recovery-phrase screens use for their notice text).
    const chain = source.chain ?? getChain();
    const phrase = MnemonicHelper.normalize(source.mnemonic);
    const root = chain === 'nem' ? nemAccountFromMnemonic(phrase, 0) : MnemonicHelper.accountFromMnemonic(phrase, 0, source.symbolCoinType);
    const address = addressOf(chain, root.publicKey);
    input = {
      chain,
      network,
      kind: 'mnemonic',
      words: phrase.split(' '),
      address,
      publicKey: root.publicKey,
      derivationPath: chain === 'nem' ? nemPath(0) : symbolPath(0, source.symbolCoinType),
      secretQrPng: chain === 'symbol' ? await qrToPng(symbolQr(QR_TYPE_MNEMONIC, { plainMnemonic: phrase })) : undefined,
      publicQrPng: await qrToPng(chain === 'nem' ? buildNemAddressQr(address) : symbolQr(QR_TYPE_CONTACT, { name: 'Root account', publicKey: root.publicKey })),
      markPng,
      createdAt: now,
    };
  } else {
    const { chain, privateKey, publicKey } = source;
    const address = addressOf(chain, publicKey);
    input = {
      chain,
      network,
      kind: 'key',
      privateKey,
      address,
      publicKey,
      secretQrPng: chain === 'symbol' ? await qrToPng(symbolQr(QR_TYPE_ACCOUNT, { privateKey })) : undefined,
      publicQrPng: await qrToPng(chain === 'nem' ? buildNemAddressQr(address) : symbolQr(QR_TYPE_CONTACT, { name: 'KASANE account', publicKey })),
      markPng,
      createdAt: now,
    };
  }

  const bytes = await buildPaperWalletPdf(input);
  const filename = `kasane-paper-wallet-${input.chain}-${source.kind === 'mnemonic' ? 'phrase' : 'key'}-${stamp(now)}.pdf`;
  return { bytes, filename };
}

/** Builds the paper wallet PDF and downloads it (or opens the share sheet on iOS). */
export async function downloadPaperWallet(source: PaperWalletSource): Promise<void> {
  const { bytes, filename } = await createPaperWalletPdf(source);
  await saveFile(bytes, filename);
}
