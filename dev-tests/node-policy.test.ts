// Run: npx tsx dev-tests/node-policy.test.ts
// Checks lib/nodePolicy.ts: https is always fine, plain http only for this computer / the local network.
import { isAllowedNodeUrl, isLocalHost } from '../src/lib/nodePolicy';

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

// https: any host
check('https public node', isAllowedNodeUrl('https://symbol-mikun.net:3001'));
check('https with a trailing slash and spaces', isAllowedNodeUrl('  https://node.example.com:3001/ '));
check('https to an IP address', isAllowedNodeUrl('https://203.0.113.5:3001'));

// http: only local
check('http localhost', isAllowedNodeUrl('http://localhost:3000'));
check('http 127.0.0.1', isAllowedNodeUrl('http://127.0.0.1:3000'));
check('http 127.5.5.5 (loopback range)', isAllowedNodeUrl('http://127.5.5.5:3000'));
check('http 192.168.1.20', isAllowedNodeUrl('http://192.168.1.20:3000'));
check('http 10.0.0.7', isAllowedNodeUrl('http://10.0.0.7:3000'));
check('http 172.16.0.1 and 172.31.255.254', isAllowedNodeUrl('http://172.16.0.1:3000') && isAllowedNodeUrl('http://172.31.255.254:3000'));
check('http 169.254.1.1 (link-local)', isAllowedNodeUrl('http://169.254.1.1:3000'));
check('http ::1', isAllowedNodeUrl('http://[::1]:3000'));
check('http fd00:: (unique local)', isAllowedNodeUrl('http://[fd12:3456::1]:3000'));
check('http fe80:: (link-local)', isAllowedNodeUrl('http://[fe80::1]:3000'));
check('http mock.local (mDNS name)', isAllowedNodeUrl('http://mock.local'));
check('http foo.localhost', isAllowedNodeUrl('http://foo.localhost:3000'));

// http: not local
check('http public domain is refused', !isAllowedNodeUrl('http://symbol-mikun.net:3000'));
check('http public IP is refused', !isAllowedNodeUrl('http://203.0.113.5:3000'));
check('http 172.15.x / 172.32.x are public', !isAllowedNodeUrl('http://172.15.0.1:3000') && !isAllowedNodeUrl('http://172.32.0.1:3000'));
check('http 192.169.x is public', !isAllowedNodeUrl('http://192.169.1.1:3000'));
check('http 11.0.0.1 is public', !isAllowedNodeUrl('http://11.0.0.1:3000'));
check('a host that merely starts with "localhost" is public', !isAllowedNodeUrl('http://localhost.evil.example:3000'));
check('a host that merely contains ".local" inside is public', !isAllowedNodeUrl('http://my.local.evil.example:3000'));
check('http 10.0.0.1.evil.example is public', !isAllowedNodeUrl('http://10.0.0.1.evil.example:3000'));
check('http with credentials trick (user@host)', !isAllowedNodeUrl('http://localhost@evil.example:3000'));
check('http public ipv6 is refused', !isAllowedNodeUrl('http://[2001:db8::1]:3000'));

// other schemes / garbage
check('ftp is refused', !isAllowedNodeUrl('ftp://localhost'));
check('javascript: is refused', !isAllowedNodeUrl('javascript:alert(1)'));
check('empty is refused', !isAllowedNodeUrl(''));
check('garbage is refused', !isAllowedNodeUrl('not a url'));
check('scheme-less is refused (callers add https:// themselves)', !isAllowedNodeUrl('node.example.com:3001'));

// helpers
check('isLocalHost handles brackets and a trailing dot', isLocalHost('[::1]') && isLocalHost('localhost.'));

if (failed > 0) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall ok');
