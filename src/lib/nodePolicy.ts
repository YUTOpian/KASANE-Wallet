// Which node URLs the app may talk to.
//
// A node answers balances, history and "your transfer went through". Over plain HTTP anyone on the path
// (public Wi-Fi, a hostile router) can rewrite those answers - show a fake balance, hide an incoming
// transfer, pretend an announce succeeded. The page cannot rely on the browser's mixed-content block to stop
// this: a single-file build opened from file:// is not blocked at all. So the rule is enforced here:
//   - https://  : always allowed.
//   - http://   : only for a machine on this computer or this local network (localhost, 127.x, 10.x,
//                 172.16-31.x, 192.168.x, link-local, *.local), where nobody sits in between.
// Signing is not affected either way (the generation hash is fixed and the transaction is signed on this
// device), but the screens must not be lied to.

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** True for a host that is this computer or on its local network (never reachable from the open internet). */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const v4 = ipv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (host.includes(':')) {
    // IPv6: loopback, unique local (fc00::/7) and link-local (fe80::/10)
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

/** A node URL the app is willing to send requests to (see the rule above). Anything else, including garbage, is false. */
export function isAllowedNodeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return u.hostname !== '';
  if (u.protocol === 'http:') return isLocalHost(u.hostname);
  return false;
}

