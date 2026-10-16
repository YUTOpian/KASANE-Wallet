// Run: npx tsx dev-tests/ledger-apps.test.ts
// Checks lib/ledger/apps.ts against a fake device. The byte layouts below follow the official code
// (Symbol Desktop Wallet 1.2.0 `Ledger.ts`, NEM Wallet `hw-app-nem.js`):
//   get public key: data = path + network byte; Symbol reply [32][pk]; NEM reply [40][address][32][pk]
//   sign: P1 0x80 = more follows, 0x01 = not the first chunk; P2 = 0x80 (Ed25519) for both apps
// NOTE: this proves the code matches those layouts. It does NOT prove a real device accepts it (see docs/FEATURES.md, Ledger).
import { accountRequestData, getLedgerAccount, ledgerPath, ledgerSign, nemLedgerPath, PROTOCOL, signP1, symbolLedgerPath } from '../src/lib/ledger/apps';
import { LedgerError, serializePath } from '../src/lib/ledger/framing';
import type { LedgerTransport } from '../src/lib/ledger/transport';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
async function kindOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof LedgerError ? e.kind : `other:${(e as Error).message}`; }
}
const ok = (data: number[] = []) => Uint8Array.from([...data, 0x90, 0x00]);
const status = (sw: number) => Uint8Array.from([sw >> 8, sw & 0xff]);

function fake(replies: Uint8Array[]): { t: LedgerTransport; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  let i = 0;
  const t: LedgerTransport = {
    kind: 'hid',
    async exchange(apdu) { sent.push(apdu); return replies[Math.min(i++, replies.length - 1)]; },
    async close() {},
    onDisconnect() {},
  };
  return { t, sent };
}

const PUB = Array.from({ length: 32 }, (_, i) => i + 1);
const pubHex = PUB.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const NEM_ADDR = 'NABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG'.slice(0, 40).padEnd(40, 'A');
const nemAddrBytes = Array.from(new TextEncoder().encode(NEM_ADDR));
const toAddress = (pk: string, nb: number) => (pk === pubHex && nb === 0x68 ? NEM_ADDR : 'X');
const symbolReply = ok([32, ...PUB]);
const nemReply = ok([40, ...nemAddrBytes, 32, ...PUB]);

(async () => {
  // --- paths (mainnet: Symbol 4343 / NEM 43, testnet: 1 for both; the index is the third element)
  check('symbol mainnet path', symbolLedgerPath(3, 0x68) === "m/44'/4343'/3'/0'/0'");
  check('symbol testnet path', symbolLedgerPath(0, 0x98) === "m/44'/1'/0'/0'/0'");
  check('nem mainnet path', nemLedgerPath(0, 0x68) === "m/44'/43'/0'/0'/0'");
  check('nem testnet path', nemLedgerPath(2, 0x98) === "m/44'/1'/2'/0'/0'");
  check('ledgerPath matches the helpers', ledgerPath('nem', 1, 0x98) === nemLedgerPath(1, 0x98));

  // --- get public key: request
  {
    const d = accountRequestData("m/44'/4343'/0'/0'/0'", 0x68);
    check('request data = 5 + 5*4 path bytes + network byte', d.length === 1 + 5 * 4 + 1 && d[0] === 5 && d[d.length - 1] === 0x68);
  }
  {
    const { t, sent } = fake([symbolReply]);
    const acc = await getLedgerAccount(t, 'symbol', 2, 0x68, toAddress, false);
    check('symbol getAccount: public key read, address computed locally', acc.publicKey === pubHex && acc.address === NEM_ADDR);
    const a = sent[0];
    check('symbol getAccount: CLA/INS/P1/P2', a[0] === 0xe0 && a[1] === 0x02 && a[2] === 0x00 && a[3] === 0x80);
    check('symbol getAccount: data is path + network byte', a.slice(5).join() === accountRequestData(symbolLedgerPath(2, 0x68), 0x68).join() && a[4] === a.length - 5);
  }
  {
    const { t, sent } = fake([symbolReply]);
    await getLedgerAccount(t, 'symbol', 0, 0x98, () => 'T', true);
    check('symbol testnet: network byte 0x98 sent, testnet path, display sets P1', sent[0][sent[0].length - 1] === 0x98 && sent[0][2] === PROTOCOL.P1_CONFIRM
      && sent[0].slice(5, 5 + serializePath(symbolLedgerPath(0, 0x98)).length).join() === serializePath("m/44'/1'/0'/0'/0'").join());
  }
  {
    const { t, sent } = fake([nemReply]);
    const acc = await getLedgerAccount(t, 'nem', 0, 0x68, toAddress, false);
    check('nem getAccount: [40][address][32][pk] read', acc.publicKey === pubHex && acc.address === NEM_ADDR);
    check('nem getAccount: P2 is 0x80 too', sent[0][3] === 0x80 && sent[0][sent[0].length - 1] === 0x68);
  }
  {
    const wrong = ok([40, ...nemAddrBytes.map((b) => (b === 65 ? 66 : b)), 32, ...PUB]);
    const { t } = fake([wrong]);
    check('nem getAccount: address that does not match the key is refused', (await kindOf(() => getLedgerAccount(t, 'nem', 0, 0x68, toAddress))) === 'bad_response');
  }
  {
    const { t } = fake([ok([32, ...PUB, 0xff])]);
    check('symbol getAccount: extra trailing bytes are tolerated', (await kindOf(() => getLedgerAccount(t, 'symbol', 0, 0x68, toAddress))) === null);
  }
  {
    const { t } = fake([ok([31, ...PUB.slice(0, 31)])]);
    check('symbol getAccount: short key is refused', (await kindOf(() => getLedgerAccount(t, 'symbol', 0, 0x68, toAddress))) === 'bad_response');
  }
  {
    const { t } = fake([ok([40, ...nemAddrBytes, 31, ...PUB.slice(0, 31)])]);
    check('nem getAccount: short key is refused', (await kindOf(() => getLedgerAccount(t, 'nem', 0, 0x68, toAddress))) === 'bad_response');
  }
  for (const [sw, kind] of [[0x6e00, 'app_not_open'], [0x5515, 'locked'], [0x6985, 'rejected'], [0x6a80, 'unsupported_tx']] as const) {
    const { t } = fake([status(sw)]);
    check(`getAccount: status ${sw.toString(16)} -> ${kind}`, (await kindOf(() => getLedgerAccount(t, 'symbol', 0, 0x68, toAddress))) === kind);
  }

  // --- sign: P1 flags (official: single 0x00, first-with-more 0x80, middle 0x81, last 0x01)
  check('P1: one chunk = 0x00', signP1(0, 1) === 0x00);
  check('P1: two chunks = 0x80, 0x01', signP1(0, 2) === 0x80 && signP1(1, 2) === 0x01);
  check('P1: three chunks = 0x80, 0x81, 0x01', signP1(0, 3) === 0x80 && signP1(1, 3) === 0x81 && signP1(2, 3) === 0x01);

  const sig = Array.from({ length: 64 }, (_, i) => 255 - i);
  {
    const { t, sent } = fake([ok(), ok(sig)]);
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    const out = await ledgerSign(t, 'symbol', 1, 0x68, payload);
    check('sign: signature returned', out.length === 64 && out.join() === sig.join());
    check('sign: two chunks, P1 0x80 then 0x01, P2 0x80', sent.length === 2 && sent[0][2] === 0x80 && sent[1][2] === 0x01 && sent[0][3] === 0x80 && sent[1][3] === 0x80);
    const pathBytes = serializePath(symbolLedgerPath(1, 0x68));
    check('sign: first chunk starts with the path', sent[0].slice(5, 5 + pathBytes.length).join() === pathBytes.join());
    check('sign: first chunk is 255 bytes (path + 234 of payload)', sent[0][4] === 255);
    const body = [...sent[0].slice(5 + pathBytes.length), ...sent[1].slice(5)];
    check('sign: all payload bytes sent in order', body.join() === Array.from(payload).join());
  }
  {
    const { t, sent } = fake([ok(), ok(), ok(sig)]);
    await ledgerSign(t, 'symbol', 0, 0x68, new Uint8Array(600));
    check('sign: three chunks use 0x80, 0x81, 0x01', sent.length === 3 && sent[0][2] === 0x80 && sent[1][2] === 0x81 && sent[2][2] === 0x01);
  }
  {
    const { t, sent } = fake([ok(sig)]);
    await ledgerSign(t, 'nem', 0, 0x98, Uint8Array.from([1, 2, 3]));
    check('sign: short payload is one command, P1 0x00, nem P2 0x80', sent.length === 1 && sent[0][2] === 0x00 && sent[0][3] === 0x80);
    check('sign: nem testnet uses the testnet path', sent[0].slice(5, 5 + serializePath("m/44'/1'/0'/0'/0'").length).join() === serializePath("m/44'/1'/0'/0'/0'").join());
  }
  {
    const { t } = fake([ok([1, 2, 3])]);
    check('sign: short signature is refused', (await kindOf(() => ledgerSign(t, 'symbol', 0, 0x68, Uint8Array.from([1])))) === 'bad_response');
  }
  {
    const { t } = fake([ok(), status(0x6985)]);
    check('sign: rejection on the second chunk surfaces', (await kindOf(() => ledgerSign(t, 'symbol', 0, 0x68, new Uint8Array(400)))) === 'rejected');
  }

  console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
