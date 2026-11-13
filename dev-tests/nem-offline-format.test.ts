// NEM のオフライン署名: 署名済みデータ（/transaction/announce の本文）の QR 化と読み取り。SDK を使わない部分。
// Run: npx tsx dev-tests/nem-offline-format.test.ts
import { buildNemSignedQr, parseNemSigned, readNemTransfer } from '../src/lib/nem/offline';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
function throws(fn: () => unknown, what: string) { let t = false; try { fn(); } catch { t = true; } ok(t, what); }

// A NIS1 transfer serialized by hand (the documented binary layout), so the reader is checked against the format
// itself and not against the code that wrote it.
const enc = new TextEncoder();
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return [...b]; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return [...b]; };
const sized = (b: number[] | Uint8Array) => [...u32(b.length), ...b];
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

const SIGNER = Array.from({ length: 32 }, (_, i) => i + 1);
const RECIPIENT = 'TALICE2GMA3MKWYFBTQV6UUCV5WI6VLZBTAAHGD2'.slice(0, 40).padEnd(40, 'A');
const EPOCH = 1427587585;
const TS = 300_000_000; // seconds after the NEM epoch

function transfer(opts: { version: 1 | 2; network: number; amount: bigint; message?: { type: number; payload: Uint8Array }; mosaics?: Array<{ ns: string; name: string; quantity: bigint }>; fee?: bigint; deadline?: number }): number[] {
  const out = [
    ...u32(0x101), ...u32((opts.network << 24) | opts.version), ...u32(TS), ...sized(SIGNER), ...u64(opts.fee ?? 50_000n), ...u32(opts.deadline ?? TS + 7200),
    ...sized(enc.encode(RECIPIENT)), ...u64(opts.amount),
    ...(opts.message ? sized([...u32(opts.message.type), ...sized(opts.message.payload)]) : u32(0)),
  ];
  if (opts.version === 2) {
    out.push(...u32(opts.mosaics?.length ?? 0));
    for (const m of opts.mosaics ?? []) {
      out.push(...sized([...sized([...sized(enc.encode(m.ns)), ...sized(enc.encode(m.name))]), ...u64(m.quantity)]));
    }
  }
  return out;
}

// --- version 1: a plain XEM transfer with a message
const v1 = readNemTransfer(hex(transfer({ version: 1, network: 0x98, amount: 12_500_000n, message: { type: 1, payload: enc.encode('こんにちは') } })));
ok(v1.typeValue === 0x101 && v1.version === 1, 'v1: type and version', [v1.typeValue, v1.version]);
ok(v1.networkByte === 0x98, 'v1: network byte is the high byte of the version field', v1.networkByte);
ok(v1.signerPublicKey === hex(SIGNER), 'v1: signer');
ok(v1.fee === 50_000n, 'v1: fee');
ok(v1.timestampMs === (TS + EPOCH) * 1000 && v1.deadlineMs === (TS + 7200 + EPOCH) * 1000, 'v1: times are counted from the NEM epoch');
ok(v1.transfer?.recipient === RECIPIENT, 'v1: recipient');
ok(v1.transfer?.mosaics.length === 1 && v1.transfer.mosaics[0].id === 'nem:xem' && v1.transfer.mosaics[0].quantity === 12_500_000n, 'v1: the amount is XEM in micro-XEM');
ok(v1.transfer?.message?.text === 'こんにちは' && v1.transfer.message.encrypted === false, 'v1: plain message');

// --- no message
const v1n = readNemTransfer(hex(transfer({ version: 1, network: 0x68, amount: 1n })));
ok(v1n.transfer?.message === null && v1n.networkByte === 0x68, 'v1: no message, mainnet');

// --- an encrypted message is not shown
const enc2 = readNemTransfer(hex(transfer({ version: 1, network: 0x68, amount: 1n, message: { type: 2, payload: new Uint8Array(64).fill(7) } })));
ok(enc2.transfer?.message?.encrypted === true && enc2.transfer.message.text === null && enc2.transfer.message.bytes === 64, 'v1: an encrypted message is reported as such');

// --- version 2: mosaics, the multiplier applies to every quantity
const v2 = readNemTransfer(hex(transfer({ version: 2, network: 0x98, amount: 1_000_000n, mosaics: [{ ns: 'ns.sub', name: 'token', quantity: 12_345n }, { ns: 'nem', name: 'xem', quantity: 2_500_000n }] })));
ok(v2.version === 2 && v2.transfer?.mosaics.length === 2, 'v2: both mosaics', v2.transfer?.mosaics);
ok(v2.transfer?.mosaics[0].id === 'ns.sub:token' && v2.transfer.mosaics[0].quantity === 12_345n, 'v2: id and quantity');
ok(v2.transfer?.mosaics[1].id === 'nem:xem' && v2.transfer.mosaics[1].quantity === 2_500_000n, 'v2: XEM as an attached mosaic');
const v2x = readNemTransfer(hex(transfer({ version: 2, network: 0x98, amount: 3_000_000n, mosaics: [{ ns: 'a', name: 'b', quantity: 10n }] })));
ok(v2x.transfer?.mosaics[0].quantity === 30n, 'v2: a multiplier of x3 triples the quantity', v2x.transfer?.mosaics);

// --- other types: only the header is read
const other = readNemTransfer(hex([...u32(0x4004), ...u32((0x98 << 24) | 1), ...u32(TS), ...sized(SIGNER), ...u64(1n), ...u32(TS + 1), ...u32(0)]));
ok(other.typeValue === 0x4004 && other.transfer === null, 'another type has no transfer');

// --- malformed
const good = hex(transfer({ version: 1, network: 0x98, amount: 1n }));
throws(() => readNemTransfer(good.slice(0, good.length - 8)), 'truncated');
throws(() => readNemTransfer(good + '00'), 'trailing byte');
throws(() => readNemTransfer('ZZ'), 'not hex');
throws(() => readNemTransfer(hex(transfer({ version: 1, network: 0x98, amount: 1n, message: { type: 9, payload: new Uint8Array(1) } }))), 'unknown message type');

// --- envelope
const sig = 'AB'.repeat(64);
const body = JSON.stringify({ data: good, signature: sig });
const qr = buildNemSignedQr(body, 0x98);
const parsed = parseNemSigned(qr);
ok(parsed !== null && parsed.networkId === 0x98 && parsed.body.data === good && parsed.body.signature === sig, 'QR round trip', parsed);
ok(JSON.parse(qr).kind === 'nem_signed', 'kind');
const bare = parseNemSigned(body);
ok(bare !== null && bare.networkId === null && bare.body.data === good, 'a bare announce body (NanoWallet) is read, naming no network');
ok(parseNemSigned(JSON.stringify({ data: good.toLowerCase(), signature: sig.toLowerCase() }))?.body.data === good, 'lower-case hex is accepted');
ok(parseNemSigned(JSON.stringify({ data: good, signature: 'AB' })) === null, 'a short signature is refused');
ok(parseNemSigned(JSON.stringify({ data: 'ZZ', signature: sig })) === null, 'data that is not hex is refused');
ok(parseNemSigned(JSON.stringify({ kasane: 1, kind: 'signed', network_id: 104, data: { payload: 'AA', hash: 'BB' } })) === null, 'a Symbol KASANE QR is not a NEM one');
ok(parseNemSigned('not json') === null && parseNemSigned('') === null, 'garbage');
throws(() => buildNemSignedQr('{"data":"AA","signature":"BB"}', 0x68), 'building from something that is not a signed transaction');

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
