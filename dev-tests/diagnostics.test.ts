// 診断コンソール: ログの記録・上限・絞り込み・秘密情報の伏せ字。
// Run: npx tsx dev-tests/diagnostics.test.ts
import {
  MAX_LOG_ENTRIES, buildReport, clearLog, filterLog, formatArgs, formatEntry, getLogEntries, installDiagnostics, log, redact, subscribeLog,
} from '../src/lib/diagnostics';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const PRIV = 'A'.repeat(64);
const HASH = 'B1'.repeat(32);

// --- redaction
ok(!redact(`signing with ${PRIV}`).includes(PRIV), 'a bare 64-hex key is hidden', redact(`signing with ${PRIV}`));
ok(redact(`announced hash ${HASH}`).includes(HASH), 'a transaction hash is kept', redact(`announced hash ${HASH}`));
ok(redact(`publicKey: ${HASH}`).includes(HASH), 'a public key is kept');
ok(!redact(`privateKey: ${HASH}`).includes(HASH), 'a private key is hidden even next to other words', redact(`privateKey: ${HASH}`));
ok(redact('password=hunter2 ok').includes('[hidden]') && !redact('password=hunter2 ok').includes('hunter2'), 'password=value hidden');
const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
ok(!redact(`restoring ${phrase}`).includes('abandon'), 'a 12-word phrase is hidden', redact(`restoring ${phrase}`));
ok(redact('GET /accounts/TABCDEF failed after 3 attempts').includes('/accounts/TABCDEF'), 'ordinary text is left alone');
ok(redact('x'.repeat(2500)).length < 2100, 'a very long message is cut');

// --- object arguments
const joined = formatArgs(['saved', { name: 'a', privateKey: PRIV, password: 'pw', n: 5n }, new Error('boom')]);
ok(!joined.includes(PRIV) && !joined.includes('"pw"') && joined.includes('"n":"5"') && joined.includes('Error: boom'), 'secret-looking keys are hidden in objects', joined);
ok(formatArgs([undefined, 3]) === 'undefined 3', 'plain values');

// --- buffer, subscribe, filter
clearLog();
let notified = 0;
const off = subscribeLog(() => { notified++; });
log('debug', 'node', 'GET /chain/info 12 ms');
log('info', 'app', 'hello');
log('warn', 'node', 'GET /accounts ✗ slow');
log('error', 'window', 'TypeError: x');
ok(getLogEntries().length === 4 && notified === 4, 'entries recorded and listeners told', notified);
ok(filterLog(getLogEntries(), 'info', '').length === 3, 'info level hides debug');
ok(filterLog(getLogEntries(), 'warn', '').length === 2, 'warn level');
ok(filterLog(getLogEntries(), 'error', '').length === 1, 'error level');
ok(filterLog(getLogEntries(), 'debug', 'ACCOUNTS').length === 1, 'search is case-insensitive');
ok(filterLog(getLogEntries(), 'debug', 'window').length === 1, 'search also covers the source');
for (let i = 0; i < MAX_LOG_ENTRIES + 50; i++) log('info', 'app', `line ${i}`);
const all = getLogEntries();
ok(all.length === MAX_LOG_ENTRIES && all[all.length - 1].message === `line ${MAX_LOG_ENTRIES + 49}`, 'the oldest entries are dropped at the cap', all.length);
ok(all.every((e, i) => i === 0 || e.id > all[i - 1].id), 'ids keep increasing');

// --- report
const report = buildReport([['chain / network', 'symbol / mainnet']], all.slice(-2));
ok(report.startsWith('KASANE Wallet diagnostics\nchain / network: symbol / mainnet\n\n') && report.split('\n').length === 5, 'report has a header then the lines', report);
ok(/^\d\d:\d\d:\d\d\.\d{3} INFO  \[app\] line /.test(formatEntry(all[0])), 'a line is formatted with time, level and source', formatEntry(all[0]));

clearLog();
ok(getLogEntries().length === 0, 'clear empties the log');
off();
installDiagnostics(); // no window here: must be a harmless no-op
ok(getLogEntries().length === 0, 'installing outside a browser does nothing');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
