// アポスティーユの「証明書」画像（PNG）: ブラウザの canvas に描く。日本語のファイル名もそのまま出せる。
// NanoWallet の証明書（背景画像に文字を載せる形）と同じ項目を、KASANE の見た目で。端末の中だけで作り、送信しない。
import { loadMark, qrToPng } from './paperWalletExport';

export interface CertificateInfo {
  fileName: string;
  date: Date;
  owner: string; // address
  tags: string;
  signed: boolean;
  hashName: string;
  dedicatedAccount: string; // address the apostille was sent to
  txHash: string;
  /** The transaction message (hex). */
  messageHex: string;
  explorerUrl: string;
  network: 'mainnet' | 'testnet';
}

const W = 1240;
const H = 1754;
const INK = '#262129';
const MUTED = '#7A7080';
const LINE = '#E4DDEC';
const TINT = '#F6F2FA';

function loadImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('certificate: image could not be loaded')); };
    img.src = url;
  });
}

/** Breaks `text` into lines that fit `maxWidth`, by characters (hashes and Japanese have no spaces). */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  lines.push(line);
  return lines;
}

export async function drawApostilleCertificate(info: CertificateInfo): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('certificate: no canvas');
  const sans = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", Roboto, Arial, sans-serif';
  const mono = '"SF Mono", Menlo, Consolas, "Courier New", monospace';

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // header band with the KASANE gradient edge
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, 230);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#FA7268');
  grad.addColorStop(0.35, '#E58AAE');
  grad.addColorStop(0.65, '#B79BD0');
  grad.addColorStop(1, '#55E2A0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 230, W, 8);
  const mark = await loadImage(await loadMark());
  ctx.drawImage(mark, 70, 45, 140, 140);
  ctx.fillStyle = '#EAF4A6';
  ctx.font = `300 76px ${sans}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('KASANE', 250, 120);
  ctx.font = `34px ${sans}`;
  ctx.fillText('APOSTILLE CERTIFICATE', 252, 172);
  ctx.textAlign = 'right';
  ctx.font = `bold 28px ${sans}`;
  ctx.fillStyle = '#7ED1C0';
  ctx.fillText(`NEM ${info.network === 'mainnet' ? 'MAINNET' : 'TESTNET'}`, W - 70, 120);
  ctx.textAlign = 'left';

  // details
  let y = 330;
  const left = 70;
  const labelW = 250;
  const valueMax = W - left - labelW - 70 - 330; // leave room for the QR on the first rows
  const row = (label: string, value: string, font = `34px ${sans}`, maxWidth = W - left - labelW - 70) => {
    ctx.fillStyle = MUTED;
    ctx.font = `bold 24px ${sans}`;
    ctx.fillText(label, left, y);
    ctx.fillStyle = INK;
    ctx.font = font;
    const lines = wrap(ctx, value || '-', maxWidth);
    lines.forEach((line, i) => ctx.fillText(line, left + labelW, y + i * 44));
    y += Math.max(1, lines.length) * 44 + 34;
  };
  row('FILE', info.fileName, `bold 36px ${sans}`, valueMax);
  row('DATE', info.date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC', `34px ${sans}`, valueMax);
  row('OWNER', info.owner, `30px ${mono}`, valueMax);
  row('TAGS', info.tags, `34px ${sans}`, valueMax);
  row('TYPE', `${info.signed ? 'Signed (private)' : 'Public'} / ${info.hashName}`, `34px ${sans}`, valueMax);

  // QR (explorer link of the transaction), top right
  const qr = await loadImage(await qrToPng(info.explorerUrl, { level: 'M', size: 700 }));
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 3;
  ctx.fillStyle = '#fff';
  ctx.fillRect(W - 70 - 300, 300, 300, 300);
  ctx.strokeRect(W - 70 - 300, 300, 300, 300);
  ctx.drawImage(qr, W - 70 - 290, 310, 280, 280);
  ctx.fillStyle = MUTED;
  ctx.font = `20px ${sans}`;
  ctx.textAlign = 'center';
  ctx.fillText('Scan to view the transaction', W - 70 - 150, 632);
  ctx.textAlign = 'left';

  y = Math.max(y, 700);
  ctx.fillStyle = LINE;
  ctx.fillRect(left, y - 30, W - left * 2, 3);
  y += 30;

  // chain data
  const full = W - left - labelW - 70;
  row('SENT TO', info.dedicatedAccount, `30px ${mono}`, full);
  row('TX HASH', info.txHash, `26px ${mono}`, full);
  const boxTop = y - 40;
  ctx.fillStyle = TINT;
  const msgLines = wrap(ctx, info.messageHex, full).length;
  ctx.fillRect(left - 20, boxTop, W - left * 2 + 40, 60 + msgLines * 38);
  ctx.font = `26px ${mono}`;
  ctx.fillStyle = MUTED;
  ctx.font = `bold 24px ${sans}`;
  ctx.fillText('MESSAGE', left, y);
  ctx.fillStyle = INK;
  ctx.font = `26px ${mono}`;
  wrap(ctx, info.messageHex, full).forEach((line, i) => ctx.fillText(line, left + labelW, y + i * 38));
  y += msgLines * 38 + 80;

  // notes
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${sans}`;
  const notes = [
    'This certificate shows that the hash of the file above was recorded on the NEM blockchain.',
    info.signed
      ? 'The recorded message holds the owner\'s signature of the file hash.'
      : 'The recorded message holds the hash of the file.',
    'To check a file, open Services > Apostille > Audit in KASANE and select the renamed file.',
    'Keep the renamed file exactly as it is: changing even one byte of it makes the audit fail.',
  ];
  for (const line of notes) {
    for (const part of wrap(ctx, line, W - left * 2)) {
      ctx.fillText(part, left, y);
      y += 36;
    }
    y += 6;
  }

  // footer
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - 90, W, 4);
  ctx.fillStyle = MUTED;
  ctx.font = `22px ${sans}`;
  ctx.fillText('Generated locally on this device by KASANE Wallet', left, H - 45);
  ctx.textAlign = 'right';
  ctx.fillText('KASANE', W - left, H - 45);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('certificate: image could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}
