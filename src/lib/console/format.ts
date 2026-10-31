// コンソールの出力用に、値を文字列にする（ブラウザの開発者ツールに近い見た目）。
// BigInt は「123n」、Uint8Array は「Uint8Array(3) [ 1, 2, 3 ]」。SDK のクラス（Address / PublicKey / Hash256 など）は
// toString() の結果をクラス名つきで出す。循環参照・深すぎる入れ子・長すぎる配列は省く。

const MAX_DEPTH = 4;
const MAX_ITEMS = 100;
const MAX_BYTES = 64;
const LINE_WIDTH = 76;

const hasCustomToString = (v: object): boolean => {
  const ts = (v as { toString?: unknown }).toString;
  return typeof ts === 'function' && ts !== Object.prototype.toString && ts !== Array.prototype.toString && ts !== Error.prototype.toString;
};

function className(v: object): string {
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto === null) return 'Object: null prototype';
  const ctor = (proto as { constructor?: { name?: unknown } }).constructor;
  return typeof ctor?.name === 'string' && ctor.name !== '' ? ctor.name : 'Object';
}

function quote(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n') + q;
}

function fmt(v: unknown, depth: number, seen: object[], indent: string): string {
  switch (typeof v) {
    case 'undefined': return 'undefined';
    case 'boolean': return String(v);
    case 'number': return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint': return `${v}n`;
    case 'symbol': return v.toString();
    case 'string': return depth === 0 ? v : quote(v);
    case 'function': {
      const name = v.name;
      const kind = v.constructor?.name === 'AsyncFunction' ? 'AsyncFunction' : 'Function';
      return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`;
    }
    default: break;
  }
  if (v === null) return 'null';
  const obj = v as object;
  if (seen.includes(obj)) return '[Circular]';
  if (obj instanceof Error) {
    const head = `${obj.name}: ${obj.message}`;
    return depth === 0 ? head : `[${head}]`;
  }
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  if (obj instanceof Promise) return 'Promise { … }';
  if (obj instanceof Uint8Array) {
    const shown = [...obj.subarray(0, MAX_BYTES)].join(', ');
    const more = obj.length > MAX_BYTES ? `, … ${obj.length - MAX_BYTES} more` : '';
    return `Uint8Array(${obj.length}) [ ${shown}${more} ]`;
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `${className(obj)}(${(obj as ArrayBufferView).byteLength ?? (obj as ArrayBuffer).byteLength})`;
  if (depth >= MAX_DEPTH) return Array.isArray(obj) ? '[Array]' : `[${className(obj)}]`;
  const next = [...seen, obj];
  const inner = indent + '  ';
  const wrap = (open: string, items: string[], close: string, prefix = ''): string => {
    if (items.length === 0) return `${prefix}${open}${close}`;
    const oneLine = `${prefix}${open} ${items.join(', ')} ${close}`;
    if (oneLine.length <= LINE_WIDTH && !oneLine.includes('\n')) return oneLine;
    return `${prefix}${open}\n${inner}${items.join(`,\n${inner}`)}\n${indent}${close}`;
  };
  if (Array.isArray(obj)) {
    const items = obj.slice(0, MAX_ITEMS).map((x) => fmt(x, depth + 1, next, inner));
    if (obj.length > MAX_ITEMS) items.push(`… ${obj.length - MAX_ITEMS} more items`);
    return wrap('[', items, ']');
  }
  if (obj instanceof Map) {
    const items = [...obj.entries()].slice(0, MAX_ITEMS).map(([k, x]) => `${fmt(k, depth + 1, next, inner)} => ${fmt(x, depth + 1, next, inner)}`);
    return wrap('{', items, '}', `Map(${obj.size}) `);
  }
  if (obj instanceof Set) {
    const items = [...obj.values()].slice(0, MAX_ITEMS).map((x) => fmt(x, depth + 1, next, inner));
    return wrap('{', items, '}', `Set(${obj.size}) `);
  }
  const name = className(obj);
  if (hasCustomToString(obj)) {
    let text: string;
    try { text = String(obj); } catch { text = ''; }
    if (text !== '' && text !== '[object Object]') {
      const t = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      return t.includes('\n') ? `${name}(\n${inner}${t.split('\n').join(`\n${inner}`)}\n${indent})` : `${name}(${t})`;
    }
  }
  const keys = Reflect.ownKeys(obj).filter((k) => typeof k === 'string' && Object.getOwnPropertyDescriptor(obj, k)?.enumerable === true) as string[];
  const items = keys.slice(0, MAX_ITEMS).map((k) => {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    const val = d && 'value' in d ? fmt(d.value, depth + 1, next, inner) : '[Getter]';
    const label = /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
    return `${label}: ${val}`;
  });
  if (keys.length > MAX_ITEMS) items.push(`… ${keys.length - MAX_ITEMS} more properties`);
  return wrap('{', items, '}', name === 'Object' ? '' : `${name} `);
}

/** 1つの値を表示用の文字列にする（文字列はそのまま、それ以外は開発者ツール風）。 */
export function formatValue(v: unknown): string {
  try {
    return fmt(v, 0, [], '');
  } catch (e) {
    return `[unprintable: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

/** console.log の引数をスペースでつなぐ。 */
export function formatArgs(args: unknown[]): string {
  return args.map((a) => formatValue(a)).join(' ');
}
