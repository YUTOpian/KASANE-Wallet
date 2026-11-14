// Transaction URI: build (unsigned transfer) -> web+symbol://transaction URI -> parse back.
// Run: npx tsx dev-tests/transaction-uri.test.ts
import { facadeFor, hexToBytes, bytesToHex } from '../src/lib/symbol/crypto';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import { serializeUnsignedTransfer, signTransfer } from '../src/lib/symbol/tx';
import { KeyPair } from 'symbol-sdk/symbol';
import { PrivateKey } from 'symbol-sdk';
import { buildTransactionUri, isTransactionUri, parseTransactionUri, TRANSFER_TX_TYPE } from '../src/lib/symbol/txUri';
import { parseScanned } from '../src/lib/symbol/qr';
import { getNetworkConfig } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const NB = 0x68; // mainnet
const signer = 'A'.repeat(0) + '1'.repeat(64);
const recipient = addressFromPublicKey('2'.repeat(64), NB);
const cfg = getNetworkConfig();
const params = { signerPublicKey: signer, networkByte: NB, recipient, maxFee: 17600n, deadline: 123456789n };

// 1. one mosaic + a Japanese message round-trips
{
  const payload = serializeUnsignedTransfer({ ...params, mosaics: [{ id: '6BED913FA20223F8', amount: 12_345_678n }], message: 'こんにちは abc' });
  const bytes = hexToBytes(payload);
  ok(bytes.slice(8, 72).every((b) => b === 0), 'signature stays zero (unsigned)');
  const uri = buildTransactionUri({ payload, type: TRANSFER_TX_TYPE, nodeUrl: 'https://node.example:3001' });
  ok(uri.startsWith('web+symbol://transaction?data='), 'uri prefix', uri.slice(0, 40));
  ok(isTransactionUri(uri), 'isTransactionUri');
  const parts = parseTransactionUri(uri);
  ok(parts?.payload === payload.toUpperCase() || parts?.payload === payload, 'payload round-trips');
  ok(parts?.type === 16724, 'type is 16724');
  ok(parts?.generationHash === cfg.generationHash, 'generationHash defaults to the network');
  ok(parts?.nodeUrl === 'https://node.example:3001', 'nodeUrl round-trips (encoded)');
  const p = parseScanned(uri);
  ok(p?.address === recipient, 'recipient', p?.address);
  ok(p?.mosaicId === '6BED913FA20223F8', 'mosaic id', p?.mosaicId);
  ok(p?.amount === 'atomic:12345678', 'atomic amount', p?.amount);
  ok(p?.message === 'こんにちは abc', 'message', p?.message);
  ok(p?.unsupported === undefined, 'nothing unsupported');
  ok(p?.generationHash === cfg.generationHash, 'generationHash carried to the caller');
}

// 2. an amount-less transfer (message only) and an empty message
{
  const payload = serializeUnsignedTransfer({ ...params, mosaics: [], allowNoMosaics: true, message: 'hi' });
  const p = parseScanned(buildTransactionUri({ payload, type: TRANSFER_TX_TYPE }));
  ok(p !== null && p.amount === undefined && p.message === 'hi', 'no mosaic: address + message only', p);
  ok(p?.noMosaics === true, 'no mosaic: flagged, so the send form signs it with no mosaic (no added XYM x 0)', p);
  const payload2 = serializeUnsignedTransfer({ ...params, mosaics: [{ id: '6BED913FA20223F8', amount: 1n }], message: '' });
  const p2 = parseScanned(buildTransactionUri({ payload: payload2, type: TRANSFER_TX_TYPE }));
  ok(p2?.message === undefined && p2?.amount === 'atomic:1', 'no message', p2);
  ok(p2?.noMosaics === undefined, 'a transfer that has a mosaic is not flagged as mosaic-less', p2);
}

// 2b. issue #1: a message-only transfer URI made by another service (testnet, 0 mosaics, 0xCF bytes)
{
  const uri = 'web+symbol://transaction?data=CF000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001985441000000000000000000C783421D00000098C566273B3A55C8709DEE143B8DC9DA2DAC8FFA98FE3AAB2F00000000000000004558414D504C452D4348414C4C454E47453A30313233343536373839616263646566303132333435363738396162&type=16724&generationHash=49D6E1CE276A85B70EAFE52349AACCA389302E7A9754BCF1221E79494FC665A4';
  const p = parseScanned(uri);
  ok(p?.address === 'TDCWMJZ3HJK4Q4E55YKDXDOJ3IW2ZD72TD7DVKY', 'issue #1: recipient', p?.address);
  ok(p?.message === 'EXAMPLE-CHALLENGE:0123456789abcdef0123456789ab', 'issue #1: message', p?.message);
  ok(p?.noMosaics === true && p?.amount === undefined && p?.mosaicId === undefined && p?.extraMosaics === undefined, 'issue #1: no mosaic at all', p);
}

// 3. several mosaics: the first is the main one, the others are carried as extras (never dropped)
{
  const payload = serializeUnsignedTransfer({ ...params, mosaics: [{ id: '6BED913FA20223F8', amount: 1n }, { id: '1111111111111111', amount: 2n }], message: '' });
  const p = parseScanned(buildTransactionUri({ payload, type: TRANSFER_TX_TYPE }));
  ok(p?.unsupported === undefined, 'several mosaics are supported', p);
  const ids = [p?.mosaicId, ...(p?.extraMosaics ?? []).map((m) => m.id)].sort();
  ok(ids.join() === '1111111111111111,6BED913FA20223F8', 'both mosaics are carried', ids);
  const amounts = [p?.amount, ...(p?.extraMosaics ?? []).map((m) => m.amount)].sort();
  ok(amounts.join() === 'atomic:1,atomic:2', 'both amounts are carried', amounts);
}

// 4. an encrypted message is flagged
{
  const facade = facadeFor(NB);
  const tx = facade.transactionFactory.create({
    type: 'transfer_transaction_v1', signerPublicKey: signer, fee: 1n, deadline: 1n, recipientAddress: recipient,
    mosaics: [{ mosaicId: 0x6BED913FA20223F8n, amount: 5n }], message: Uint8Array.of(1, 2, 3, 4),
  });
  const p = parseScanned(buildTransactionUri({ payload: bytesToHex(tx.serialize()), type: TRANSFER_TX_TYPE }));
  ok(p?.unsupported === 'encrypted_message', 'encrypted message flagged', p);
}

// 5. things that must not load
{
  ok(parseScanned('web+symbol://transaction?data=ZZ&type=16724') === null, 'bad hex rejected');
  ok(parseScanned('web+symbol://transaction?type=16724') === null, 'missing data rejected');
  ok(parseScanned('web+symbol://transaction?data=0011AABB&type=16724') === null, 'garbage payload rejected');
  const payload = serializeUnsignedTransfer({ ...params, mosaics: [{ id: '6BED913FA20223F8', amount: 1n }], message: '' });
  ok(parseScanned(`web+symbol://transaction?data=${payload}&type=16705`) === null, 'non-transfer type rejected');
  ok(!isTransactionUri('web+symbol://request?recipient=x'), 'request URI is not a transaction URI');
  // existing formats still work
  const q = parseScanned(`web+symbol://request?recipient=${recipient}&amount=1.5`);
  ok(q?.address === recipient && q?.amount === '1.5', 'payment request URI still parses');
}

// 6. the same URI from a mixed-case / padded paste
{
  const payload = serializeUnsignedTransfer({ ...params, mosaics: [{ id: '6BED913FA20223F8', amount: 7n }], message: '' });
  const uri = `  WEB+SYMBOL://transaction?data=${payload.toLowerCase()}&type=16724\n`;
  const p = parseScanned(uri);
  ok(p?.amount === 'atomic:7', 'case/whitespace tolerant', p);
}

// 7. regression: a transfer WITHOUT a message must build and sign (the SDK rejects `message: undefined`)
{
  const priv = '3'.repeat(64);
  const pub = new KeyPair(new PrivateKey(priv)).publicKey.toString();
  for (const message of [undefined, '', 'x']) {
    try {
      const signed = signTransfer(priv, cfg.generationHash, { ...params, signerPublicKey: pub, mosaics: [{ id: '6BED913FA20223F8', amount: 1n }], message });
      ok(signed.payload.length > 0 && signed.hash.length === 64, `signTransfer with message ${JSON.stringify(message)}`);
    } catch (e) {
      ok(false, `signTransfer with message ${JSON.stringify(message)}`, (e as Error).message);
    }
  }
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
