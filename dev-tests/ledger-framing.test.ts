// Run: npx tsx dev-tests/ledger-framing.test.ts
// Checks lib/ledger/framing.ts: APDU, BIP32 path, chunking, HID/BLE framing round-trips, status classification.
import {
  buildApdu, splitStatus, classifyStatus, parsePath, serializePath, chunkPayload,
  hidWrap, HidReassembler, bleWrap, BleReassembler, LedgerError,
} from '../src/lib/ledger/framing';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const rnd = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);

// APDU
const apdu = buildApdu(0xe0, 0x02, 0x00, 0x80, Uint8Array.from([1, 2, 3]));
check('apdu layout', eq(apdu, Uint8Array.from([0xe0, 0x02, 0x00, 0x80, 3, 1, 2, 3])));
let tooLong = false;
try { buildApdu(0xe0, 4, 0, 0, new Uint8Array(256)); } catch { tooLong = true; }
check('apdu rejects data over 255 bytes', tooLong);

// status
const st = splitStatus(Uint8Array.from([9, 8, 0x90, 0x00]));
check('splitStatus', st.sw === 0x9000 && eq(st.data, Uint8Array.from([9, 8])));
check('status ok', classifyStatus(0x9000) === null);
check('status rejected', classifyStatus(0x6985) === 'rejected');
check('status locked', classifyStatus(0x5515) === 'locked');
check('status wrong app', classifyStatus(0x6e00) === 'app_not_open' && classifyStatus(0x6d00) === 'app_not_open');
check('status unknown', classifyStatus(0x1234) === 'unknown');
let short = false;
try { splitStatus(Uint8Array.from([1])); } catch (e) { short = e instanceof LedgerError; }
check('splitStatus rejects short response', short);

// path
check('parsePath symbol', parsePath("m/44'/4343'/0'/0'/0'").join() === [44, 4343, 0, 0, 0].map((n) => (n + 0x80000000) >>> 0).join());
const sp = serializePath("m/44'/43'/2'/0'/0'");
check('serializePath: length and first element', sp.length === 21 && sp[0] === 5 && sp[1] === 0x80 && sp[4] === 44);
check('serializePath: index 2 at third slot', sp[9] === 0x80 && sp[12] === 2);
let badPath = false;
try { parsePath("m/44'/x'"); } catch { badPath = true; }
check('parsePath rejects junk', badPath);

// chunking
const prefix = serializePath("m/44'/4343'/0'/0'/0'");
for (const size of [0, 10, 234, 235, 236, 500, 1200]) {
  const payload = rnd(size);
  const chunks = chunkPayload(prefix, payload);
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { joined.set(c, at); at += c.length; }
  const expected = new Uint8Array(prefix.length + payload.length);
  expected.set(prefix, 0); expected.set(payload, prefix.length);
  check(`chunkPayload ${size}: lossless, each <=255, prefix first`, eq(joined, expected) && chunks.every((c) => c.length <= 255) && eq(chunks[0].slice(0, prefix.length), prefix));
}

// HID round trip
for (const size of [5, 57, 58, 59, 120, 261, 1000]) {
  const data = rnd(size);
  const packets = hidWrap(data);
  const re = new HidReassembler();
  let out: Uint8Array | null = null;
  packets.forEach((p, i) => { const r = re.push(p); if (r) { out = r; check(`hid ${size}: done only at last packet`, i === packets.length - 1); } });
  check(`hid ${size}: all packets are 64 bytes`, packets.every((p) => p.length === 64));
  check(`hid ${size}: round trip`, out !== null && eq(out, data));
}
let seqErr = false;
{ const p = hidWrap(rnd(200)); const re = new HidReassembler(); re.push(p[0]); try { re.push(p[2]); } catch { seqErr = true; } }
check('hid: out-of-order packet is rejected', seqErr);

// BLE round trip, with several chunk sizes
for (const chunk of [20, 23, 100, 244]) {
  for (const size of [2, 15, 300, 1000]) {
    const data = rnd(size);
    const packets = bleWrap(data, chunk);
    const re = new BleReassembler();
    let out: Uint8Array | null = null;
    for (const p of packets) { const r = re.push(p); if (r) out = r; }
    check(`ble chunk ${chunk} size ${size}: round trip`, out !== null && eq(out, data) && packets.every((p) => p.length <= chunk));
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
