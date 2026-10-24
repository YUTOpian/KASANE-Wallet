// Symbol 事前オプトイン（デモ）：オプトイン先アカウントの導出と手数料。
// Run: npx tsx dev-tests/optin-derive.test.ts
import { MnemonicHelper, slip10Ed25519 } from '../src/lib/symbol/hd';
import { OPTIN_ACCOUNT_PATH, OPTIN_VRF_PATH, createOptinMnemonic, deriveOptinDestination, optinFee, parseBip32Path } from '../src/lib/optin/derive';
import { bytesToHex } from '../src/lib/symbol/crypto';
import { NETWORKS } from '../src/lib/symbol/constants';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// 新しいニーモニック（オプトイン画面の中で作るもの）
const phrase = createOptinMnemonic([10, 20, 30.5, 400, 15, 99]);
const main = deriveOptinDestination(phrase, NETWORKS.mainnet.networkByte);
const test = deriveOptinDestination(phrase, NETWORKS.testnet.networkByte);

ok(OPTIN_ACCOUNT_PATH === "m/44'/4343'/0'/0'/0'", 'account path is the one the opt-in module used');
ok(OPTIN_VRF_PATH === "m/44'/4343'/0'/1'/0'", 'VRF path is the one the opt-in module used');
ok(MnemonicHelper.isValid(phrase) && phrase.split(' ').length === 24, 'new opt-in phrase is a valid 24-word BIP39 phrase');
ok(createOptinMnemonic() !== createOptinMnemonic(), 'two new phrases differ (random even with no cursor samples)');
ok(createOptinMnemonic([1, 2, 3]) !== createOptinMnemonic([1, 2, 3]), 'same cursor samples still give different phrases (the device random is the base)');
ok(main.mnemonic === MnemonicHelper.normalize(phrase), 'the shown mnemonic is the new phrase');

// BIP32（ed25519 は SLIP-0010 のハードン導出）：公開されているテストベクタ（seed 000102030405060708090a0b0c0d0e0f）
const seedHex = '000102030405060708090a0b0c0d0e0f';
const seed = Uint8Array.from(seedHex.match(/../g)!.map((h) => parseInt(h, 16)));
ok(bytesToHex(slip10Ed25519(seed, [])).toLowerCase() === '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7', 'SLIP-0010 vector: m');
ok(bytesToHex(slip10Ed25519(seed, [0])).toLowerCase() === '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3', "SLIP-0010 vector: m/0'");
ok(bytesToHex(slip10Ed25519(seed, [0, 1])).toLowerCase() === 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2', "SLIP-0010 vector: m/0'/1'");
ok(JSON.stringify(parseBip32Path(OPTIN_ACCOUNT_PATH)) === '[44,4343,0,0,0]', 'account path parses to the BIP44 levels');
ok(JSON.stringify(parseBip32Path(OPTIN_VRF_PATH)) === '[44,4343,0,1,0]', 'VRF path parses to the BIP44 levels');
for (const bad of ['', 'm', "44'/4343'/0'", "m/44/4343'/0'", "m/44'/4343'/0'/-1'", "m/2147483648'", "m/44'//0'"]) {
  let threw = false;
  try { parseBip32Path(bad); } catch { threw = true; }
  ok(threw, `rejects a non-hardened or malformed path: "${bad}"`);
}
ok(main.publicKey === MnemonicHelper.accountFromMnemonic(phrase, 0).publicKey, 'same key as Symbol account 0 of the phrase (same path)');
ok(main.vrfPublicKey !== main.publicKey && main.vrfPrivateKey !== main.privateKey, 'the VRF account is a different account');
ok(/^N[A-Z2-7]{5}(-[A-Z2-7]{6}){5}-?[A-Z2-7]{0,6}$/.test(main.address) && main.address.startsWith('N'), 'mainnet address starts with N, 6-char groups', main.address);
ok(test.address.startsWith('T'), 'testnet address starts with T', test.address);
ok(main.publicKey === test.publicKey, 'the network changes the address only, not the key');
ok(deriveOptinDestination(phrase, NETWORKS.mainnet.networkByte).address === main.address, 'deterministic');
ok(deriveOptinDestination(`  ${phrase.toUpperCase()}  `, NETWORKS.mainnet.networkByte).address === main.address, 'phrase is normalised');

ok(optinFee(0, false) === 0.2, 'base fee 0.2 XEM');
ok(optinFee(2, false) === 1.9, '2 namespaces: 0.2 + 2 x 0.85');
ok(optinFee(0, true) === 1.05, 'VRF key adds 0.85');
ok(optinFee(1, true) === 1.9, '1 namespace + VRF');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
if (fails) process.exit(1);
