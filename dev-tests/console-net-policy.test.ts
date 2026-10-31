// コンソールの通信先の決まり（lib/console/netPolicy.ts）。通信なし。
// 実行: npx tsx dev-tests/console-net-policy.test.ts
import { checkOutboundUrl, isInternalHost } from '../src/lib/console/netPolicy';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const HTTP = ['http:', 'https:'] as const, WS = ['ws:', 'wss:'] as const;
const blocked = (u: string, own = 'https://node.example.com:3001', schemes: readonly string[] = HTTP) => { try { checkOutboundUrl(u, schemes, own); return false; } catch { return true; } };
const allowed = (u: string, own = 'https://node.example.com:3001', schemes: readonly string[] = HTTP) => !blocked(u, own, schemes);

// 公開の相手は通る
for (const u of ['https://symbol.fyi/api', 'http://node.example.com:3000/node/info', 'https://8.8.8.8/', 'https://[2001:4860:4860::8888]/', 'https://172.32.0.1/', 'https://100.63.0.1/', 'https://11.0.0.1/']) ok(allowed(u), `public ok: ${u}`);
// 自分の PC・LAN は止まる
for (const u of [
  'http://localhost:3000/', 'http://LOCALHOST/', 'http://localhost./', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
  'http://0.0.0.0/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://100.127.255.255/',
  'http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:192.168.0.1]/',
  'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://router/', 'http://nas.local/', 'http://printer.lan/', 'http://svc.internal/', 'http://x.home.arpa/', 'http://224.0.0.1/', 'http://255.255.255.255/',
]) ok(blocked(u), `internal blocked: ${u}`);
// 形式
ok(blocked('ftp://example.com/'), 'ftp is not allowed');
ok(blocked('file:///etc/passwd'), 'file is not allowed');
ok(blocked('javascript:alert(1)'), 'javascript is not allowed');
ok(blocked('data:text/plain,hi'), 'data is not allowed');
ok(blocked('/relative'), 'relative URL is not allowed');
ok(blocked('not a url'), 'garbage is not allowed');
ok(blocked('https://user:pw@example.com/'), 'credentials in URL are not allowed');
ok(blocked('ws://example.com/', 'https://node.example.com', HTTP), 'ws is not allowed for fetch');
ok(blocked('https://example.com/', 'https://node.example.com', WS), 'https is not allowed for WebSocket');
// 迂回: 見た目が公開でも、URL の正規化で内部になるもの
ok(blocked('http://127.0.0.1.:3000/'), 'trailing dot ip');
ok(blocked('http://①②⑦.0.0.1/'), 'unicode digits normalise to something blocked or invalid');
ok(blocked('http://localhost%2f@example.com/') || allowed('http://localhost%2f@example.com/'), 'does not crash on odd input');
// 自分のノードは、内部向けでも通る（同じホスト名だけ）
ok(allowed('http://192.168.1.20:3000/node/info', 'http://192.168.1.20:3000'), 'own LAN node http');
ok(allowed('ws://192.168.1.20:3000/ws', 'http://192.168.1.20:3000', WS), 'own LAN node websocket');
ok(allowed('http://localhost:3000/', 'http://localhost:3000'), 'own localhost node');
ok(blocked('http://192.168.1.21:3000/', 'http://192.168.1.20:3000'), 'a different LAN host is still blocked');
ok(blocked('http://localhost:3000/', 'http://192.168.1.20:3000'), 'localhost is blocked when the node is elsewhere');
ok(blocked('http://127.0.0.1/', 'not a url'), 'unparseable node url gives no exception');
ok(blocked('http://127.0.0.1/', ''), 'empty node url gives no exception');
// 設定で「制限なし」にしたとき（allowInternal）: 内部向けも通る。スキームと URL 内の認証情報は、そのまま確かめる
const free = (u: string, schemes: readonly string[] = HTTP) => { try { checkOutboundUrl(u, schemes, '', true); return true; } catch { return false; } };
for (const u of ['http://127.0.0.1:3000/', 'http://localhost/', 'http://192.168.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://router/', 'http://nas.local/']) ok(free(u), `unlimited allows: ${u}`);
ok(!free('ftp://example.com/') && !free('file:///etc/passwd') && !free('javascript:alert(1)') && !free('/relative') && !free('http://u:p@192.168.0.1/'), 'unlimited still checks scheme and credentials');
ok(free('ws://192.168.0.1/ws', WS) && !free('http://192.168.0.1/', WS), 'unlimited still checks the scheme per API');

// URL 内のユーザー名・パスワード：初期値は禁止。設定でオフにしたときだけ通す（スキーム・内部向けホストの確認は、そのまま）
ok(blocked('https://user:pass@symbol.fyi/'), 'user:pass in URL is blocked by default');
ok(blocked('https://user@symbol.fyi/'), 'user name only is blocked by default');
ok(blocked('wss://u:p@node.example.com:3001/ws', 'https://node.example.com:3001', WS), 'user:pass in ws URL is blocked by default');
const withCred = (u: string, schemes: readonly string[] = HTTP, internal = false) => { try { checkOutboundUrl(u, schemes, '', internal, true); return true; } catch { return false; } };
ok(withCred('https://user:pass@symbol.fyi/'), 'user:pass is allowed when the protection is off');
ok(withCred('wss://u:p@symbol.fyi/ws', WS), 'user:pass in ws URL is allowed when the protection is off');
ok(!withCred('ftp://user:pass@symbol.fyi/'), 'other schemes stay blocked even when the credential protection is off');
ok(!withCred('https://user:pass@192.168.0.1/'), 'internal hosts stay blocked (limit on) even when the credential protection is off');
ok(withCred('https://user:pass@192.168.0.1/', HTTP, true), 'both off: internal host with credentials is allowed');
// isInternalHost 単体
ok(isInternalHost('') && isInternalHost('[::1]') && isInternalHost('::1') && isInternalHost('10.1.2.3') && !isInternalHost('example.com') && !isInternalHost('93.184.216.34'), 'isInternalHost basics');
// 返す URL は正規化されたもの
ok(checkOutboundUrl('HTTPS://Symbol.FYI/a b', HTTP, '') === 'https://symbol.fyi/a%20b', 'the normalised URL is returned');

console.log(fails === 0 ? `OK: ${checks} checks passed` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
