// コンソールのコードが通信してよい先の決まり。
//
// CSP の connect-src は、利用者がノードの URL を自由に指定できる仕様のため、https: / http: / wss: / ws: を丸ごと許している。
// そのままだと、コードが自分の PC・同じ LAN のサービス（ルーター、NAS、開発中のサーバー、localhost のウォレットなど）へ
// 「ユーザーには見えない」リクエストを出せる。そこで、コンソールの fetch / WebSocket では、次を止める。
//   - localhost、ループバック（127.0.0.0/8, ::1）、私設・リンクローカル・CGNAT のIPアドレス、ドット無しのホスト名（LAN内の名前）、
//     .local / .internal / .lan などの内部向けのドメイン。
//   - 例外は、いま使っているノード（NODE）と同じホスト名。自分のノードを LAN や localhost で動かしている人のために通す。
// 公開インターネットの相手への送信は止められない（復号した中身や得た情報を外へ送れる）。
// ホスト名が名前解決の結果で私設IPを指す場合（DNS rebinding）は、ブラウザからは見えないので止められない。

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.home.arpa'];

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateIpv4(p: number[]): boolean {
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)          // CGNAT
    || (a === 169 && b === 254)                      // リンクローカル（クラウドのメタデータもここ）
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;                                     // マルチキャスト・予約
}

/** IPv6 を8個の16ビットに展開する（URL が正規化したもの）。読めなければ null。 */
function ipv6Groups(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted !== null) {
    const v4 = ipv4Parts(dotted[2]);
    if (v4 === null) return null;
    h = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function isPrivateIpv6(g: number[]): boolean {
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;        // :: と ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true;                                              // fc00::/7 ユニークローカル
  if ((g[0] & 0xffc0) === 0xfe80) return true;                                              // fe80::/10 リンクローカル
  if ((g[0] & 0xff00) === 0xff00) return true;                                              // マルチキャスト
  const embedded = (hi: number, lo: number) => isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (first5Zero && g[5] === 0xffff) return embedded(g[6], g[7]);                           // ::ffff:a.b.c.d（IPv4射影）
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embedded(g[1], g[2]);                                         // 6to4
  return false;
}

/** ホスト名（URL が正規化したもの）が、自分の PC や LAN の内側を指すか。 */
export function isInternalHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h === '') return true;
  if (h.includes(':')) {
    const g = ipv6Groups(h);
    return g === null ? true : isPrivateIpv6(g);
  }
  if (h.startsWith('[')) return true;
  const v4 = ipv4Parts(h);
  if (v4 !== null) return isPrivateIpv4(v4);
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;   // 数字だけの怪しい書き方（URL が正規化し損ねたもの）
  if (h === 'localhost' || !h.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * コードが指定した URL を確かめて、使ってよい URL（文字列）を返す。だめなら投げる。
 * schemes: 許すスキーム（例: ['http:', 'https:']）。ownNodeUrl: いま使っているノード。同じホスト名は、内部向けでも通す。
 * allowInternal: true（設定で「制限なし」にしたとき）は、内部向けのホストも通す。スキームの確認は、常に行う（CSP の connect-src も同じ4つだけ許している）。
 * allowUrlCredentials: true（設定で「URL内のユーザー名・パスワードの禁止」をオフにしたとき）は、https://user:pass@host/ の形も通す。初期値は禁止。
 */
export function checkOutboundUrl(input: unknown, schemes: readonly string[], ownNodeUrl: string, allowInternal = false, allowUrlCredentials = false): string {
  const raw = String(input);
  let url: URL;
  try { url = new URL(raw); } catch { throw new TypeError(`an absolute ${schemes.map((s) => s.replace(':', '')).join('/')} URL is required (got "${raw}")`); }
  if (!schemes.includes(url.protocol)) throw new TypeError(`only ${schemes.map((s) => s.replace(':', '')).join(' / ')} URLs are allowed (got "${raw}")`);
  if (!allowUrlCredentials && (url.username !== '' || url.password !== '')) {
    throw new TypeError('URLs with a user name or password are not allowed (turn this protection off in the console settings if you need it)');
  }
  if (!allowInternal && isInternalHost(url.hostname)) {
    let own = '';
    try { own = new URL(ownNodeUrl).hostname.toLowerCase(); } catch { /* ノードのURLが読めなければ、例外なし */ }
    if (own === '' || url.hostname.toLowerCase() !== own) {
      throw new TypeError(`[console] requests to this computer or your local network are blocked (${url.hostname}). Only your own node (${own || 'none'}) is allowed there.`);
    }
  }
  return url.toString();
}
