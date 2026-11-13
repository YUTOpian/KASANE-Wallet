// 診断コンソール: an in-memory log of what the app did (node requests and switches, errors, console
// output) for the 設定 > 診断コンソール screen. Nothing is written to disk or sent anywhere; the log
// lives until the page is reloaded (or 消去). Secrets never belong in it: every message goes through
// redact() first, which hides keys, recovery phrases and passwords as a second line of defence.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
  id: number;
  time: number; // epoch ms
  level: LogLevel;
  source: string; // 'node' | 'app' | 'console' | 'window' ...
  message: string;
}

export const MAX_LOG_ENTRIES = 500;
const MAX_MESSAGE_LENGTH = 2000;

let entries: LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const SECRET_KEY = /priv|secret|password|passphrase|mnemonic|seed|pin\b|token/i;
// Hex of 64+ characters is a key or a hash. Hashes and public keys are useful in a log, so those are kept
// when the text right before names them; everything else is hidden.
const HEX_RUN = /[0-9a-fA-F]{64,}/g;
const SAFE_HEX_CONTEXT = /(hash|public ?key|signer|payload hash)\W{0,6}$/i;
// 12 or more short lowercase words in a row look like a recovery phrase.
const PHRASE_RUN = /\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/g;

/** Hides secrets in a log line. */
export function redact(text: string): string {
  let out = text.replace(PHRASE_RUN, '[recovery phrase hidden]');
  out = out.replace(HEX_RUN, (match, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 16), offset);
    return SAFE_HEX_CONTEXT.test(before) ? match : '[hex hidden]';
  });
  out = out.replace(/((?:private ?key|secret|password|passphrase|mnemonic|seed)\w*["']?\s*[:=]\s*)(["']?)[^\s"',}]+/gi, '$1$2[hidden]');
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH)}…(${out.length - MAX_MESSAGE_LENGTH} more)` : out;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'bigint') return arg.toString();
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg, (key, value) => (key && SECRET_KEY.test(key) ? '[hidden]' : typeof value === 'bigint' ? value.toString() : value)) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export function formatArgs(args: unknown[]): string {
  return args.map(stringifyArg).join(' ');
}

export function log(level: LogLevel, source: string, message: string): void {
  entries.push({ id: nextId++, time: Date.now(), level, source, message: redact(message) });
  if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(entries.length - MAX_LOG_ENTRIES);
  listeners.forEach((l) => l());
}

export const logDebug = (source: string, message: string) => log('debug', source, message);
export const logInfo = (source: string, message: string) => log('info', source, message);
export const logWarn = (source: string, message: string) => log('warn', source, message);
export function getLogEntries(): LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries = [];
  listeners.forEach((l) => l());
}

export function subscribeLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Entries at `min` level or above that contain `query` (case-insensitive) in the source or message. */
export function filterLog(list: LogEntry[], min: LogLevel, query: string): LogEntry[] {
  const q = query.trim().toLowerCase();
  return list.filter((e) => RANK[e.level] >= RANK[min] && (q === '' || `${e.source} ${e.message}`.toLowerCase().includes(q)));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatEntry(e: LogEntry): string {
  return `${formatTime(e.time)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`;
}

/** The text copied / downloaded: a header with the environment, then the (filtered) log. */
export function buildReport(header: Array<[string, string]>, list: LogEntry[]): string {
  const lines = ['KASANE Wallet diagnostics', ...header.map(([k, v]) => `${k}: ${v}`), '', ...list.map(formatEntry)];
  return lines.join('\n');
}

let installed = false;

/** Starts collecting console output and uncaught errors. Safe to call more than once. */
export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const levels: Array<[keyof Console, LogLevel]> = [['debug', 'debug'], ['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']];
  for (const [method, level] of levels) {
    const original = console[method] as (...args: unknown[]) => void;
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      original.apply(console, args);
      log(level, 'console', formatArgs(args));
    };
  }
  window.addEventListener('error', (e) => log('error', 'window', `${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`));
  window.addEventListener('unhandledrejection', (e) => log('error', 'window', `unhandled rejection: ${formatArgs([e.reason])}`));
  log('info', 'app', 'diagnostics started');
}
