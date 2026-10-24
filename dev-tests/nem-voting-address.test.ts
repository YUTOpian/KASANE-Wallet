import CryptoJS from 'crypto-js';
import { addressFromKeyHex, deriveOptionAddress, generatePollAddress } from '../src/lib/nem/voting';
import { nemAddressFromPublicKey } from '../src/lib/nem/crypto';

// --- reference: nem-sdk toAddress + nem-voting utils, copied from the NanoWallet bundle -------
const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function hex2a(hex: string) { let s=''; for (let i=0;i<hex.length;i+=2) s+=String.fromCharCode(parseInt(hex.substr(i,2),16)); return s; }
function b32encode(s: string) {
  const left = s.length % 5;
  let str = s; if (left !== 0) { for (let i=0;i<5-left;i++) str += '\x00'; }
  const out: string[] = [];
  for (let i=0;i<str.length;i+=5) {
    const c = [0,1,2,3,4].map(k=>str.charCodeAt(i+k));
    out.push(b32[c[0]>>3], b32[((c[0]&7)<<2)|(c[1]>>6)], b32[(c[1]>>1)&31], b32[((c[1]&1)<<4)|(c[2]>>4)], b32[((c[2]&15)<<1)|(c[3]>>7)], b32[(c[3]>>2)&31], b32[((c[3]&3)<<3)|(c[4]>>5)], b32[c[4]&31]);
  }
  let r = out.join('');
  if (left !== 0) { const cut = {1:6,2:4,3:3,4:1}[left] as number; r = r.slice(0, r.length - cut); }
  return r;
}
function refToAddress(publicKey: string, prefix: string) {
  const bin = CryptoJS.enc.Hex.parse(publicKey);
  const hash = CryptoJS.SHA3(bin, { outputLength: 256 });
  const hash2 = CryptoJS.RIPEMD160(hash);
  const vp = prefix + CryptoJS.enc.Hex.stringify(hash2);
  const temp = CryptoJS.SHA3(CryptoJS.enc.Hex.parse(vp), { outputLength: 256 });
  const chk = CryptoJS.enc.Hex.stringify(temp).substr(0, 8);
  return b32encode(hex2a(vp + chk));
}
const refPollAddress = (pk: string, title: string, prefix: string) => refToAddress(CryptoJS.SHA3(pk + title, { outputLength: 256 }).toString(), prefix);
function refOption(pollAddr: string, option: string, prefix: string) {
  let key = CryptoJS.SHA3(pollAddr + option, { outputLength: 256 }).toString();
  if (key[0] >= '8') key = '00' + key;
  return refToAddress(key, prefix);
}

let fails = 0, checks = 0;
const eq = (a: string, b: string, what: string) => { checks++; if (a !== b) { fails++; console.log('MISMATCH', what, a, b); } };
const rnd = (n: number) => Array.from({length:n},()=>Math.floor(Math.random()*16).toString(16)).join('');
const titles = ['test', 'ポール１', 'Which one? 🍣', 'a'.repeat(100), ''];
for (const [nb, prefix] of [[0x68, '68'], [0x98, '98']] as const) {
  for (let i = 0; i < 150; i++) {
    const pk = rnd(64);
    eq(addressFromKeyHex(pk, nb), refToAddress(pk, prefix), '32-byte key');
    eq(addressFromKeyHex('00' + pk, nb), refToAddress('00' + pk, prefix), '33-byte key');
    eq(nemAddressFromPublicKey(pk, nb), addressFromKeyHex(pk, nb), 'vs symbol-sdk facade');
    for (const t of titles) {
      const pa = generatePollAddress(t, pk.toUpperCase(), nb);
      eq(pa, refPollAddress(pk, t, prefix), 'poll address ' + t);
      for (const o of ['はい', 'No', 'Option ' + i, '']) eq(deriveOptionAddress(pa, o, nb), refOption(pa, o, prefix), 'option ' + o);
    }
  }
}
console.log(`checks=${checks} fails=${fails}`);
process.exit(fails ? 1 : 0);
