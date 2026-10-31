// NEM DNS: ポインタアカウント（公開鍵・アドレス）が NanoWallet と同じになること。Run: npx tsx dev-tests/nem-dns-pointer.test.ts （symbol-sdk が必要）
// 期待値は、NEM Wallet 2.7.1 の nem-sdk（derivePassSha → keyPair.create → address.toAddress）で実際に計算したもの。
import { nemDnsPointer } from '../src/lib/nem/dnsApi';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const vectors = [
  { ns: 'nem', pub: '2129ca1f76f85024e3d2c992615f21d3830f2cec35c0a1233719c7fafaf3bc55', main: 'NB4TK4QKJGJGZECIGKC3YOIL4KC6HLWQ6WBMBCUJ', test: 'TB4TK4QKJGJGZECIGKC3YOIL4KC6HLWQ6VQUGYHG' },
  { ns: 'test', pub: 'c45d36259863add64a27aac0f6204c2f403ea87a332315b9f8ce8db955e3ea2f', main: 'NAEWA4ILDDQQOERVGZTCWXNHSYMCJJNERDNVZ7CG', test: 'TAEWA4ILDDQQOERVGZTCWXNHSYMCJJNERBKVPKYE' },
  { ns: 'symbol', pub: 'a93400ca27047717c7ac990caba8f4de6505c072e395fea587ff3cd0fcdafc21', main: 'NAQBGE5MHU4DTS54XXNNS6TQ7Y6IT746VHWX6QBV', test: 'TAQBGE5MHU4DTS54XXNNS6TQ7Y6IT746VGV5FMPY' },
  { ns: 'alice.bob', pub: '100ef486692aa6a71f2411d4d2562eda22af6e103c0fd589e5e5e2fbb2d64a06', main: 'NCQXHOU2W4H5DJSXJBBLRDJD7FMPRAU3GUJVRP7H', test: 'TCQXHOU2W4H5DJSXJBBLRDJD7FMPRAU3GXYWZIMQ' },
  { ns: '日本語', pub: 'f6896dd04a016e6046ef0b937101f3d6ebdbc2340f38f77b6ec014073ff30119', main: 'NBD5VUXBFATIZR7YRXI6FFAIMUGQS5XWU2RMJKBM', test: 'TBD5VUXBFATIZR7YRXI6FFAIMUGQS5XWUZML5TDG' },
  { ns: 'kasane', pub: '895b4f66f0e8b6f5b96968ace52220dfc10fe27c4d78e9b6901e612e10593e5b', main: 'NCYGT6R7ZRWV2W3ENCG4XOE2VARNREXAAUV4DNPZ', test: 'TCYGT6R7ZRWV2W3ENCG4XOE2VARNREXAAUEXWUCB' },
];
for (const v of vectors) {
  const main = nemDnsPointer(v.ns, 0x68);
  const test = nemDnsPointer(v.ns, 0x98);
  ok(main.publicKey === v.pub.toUpperCase(), `${v.ns}: public key`, main.publicKey);
  ok(main.address === v.main, `${v.ns}: mainnet address`, main.address);
  ok(test.address === v.test, `${v.ns}: testnet address`, test.address);
}

console.log(fails === 0 ? `ALL OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
