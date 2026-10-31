// 「コンソール」の実行環境: コードから見える変数（グローバル）を組み立てる。
//
// 速習Symbol のコードがそのまま動くことを目標にする。
//   - `facade`（SymbolFacade）・`NODE`（ノードのURL）・SDK のクラス（PrivateKey, models, generateMosaicId …）は、最初から使える。
//     `await import('…symbol-sdk…')` も通る（中身は同梱のSDK）。ネットワークから別のコードは読み込まない。
//   - このウォレットで使っているアカウントは `alice`（`wallet` でも同じ。SDK の account と同じ使い方: alice.address / alice.publicKey / alice.signTransaction(tx)）。`bob` などの名前は、自分で作るアカウント用にあけてある。
//     `walletKeyPair` / `walletAddress` も使える。秘密鍵はコードの側に渡さない。
//     署名が要るとき（wallet.signTransaction(tx)、facade.signTransaction(walletKeyPair, tx) など）は、そのつど確認ダイアログ（内容の表示 + パスワード）を挟む。
//     `wallet.messageEncoder()` の encode / tryDecode（暗号化メッセージ）も、そのつど確認を挟む。鍵ではなく、結果（暗号文・復号した中身）だけがコードに返る。
//   - 速習Symbol の事前準備にある `clog(tx)`（確認用のURLを出す）と、`networkType` / `identifier` も用意する。
//     自分で作った鍵（`new facade.static.KeyPair(PrivateKey.random())` など）は、確認なしで普通に署名される（ウォレットの鍵ではないため）。
//   - fetch / WebSocket / setTimeout は使える。window・document・localStorage などは見えない（interpreter.ts）。
//
// NEM（NIS1）のとき（opts.chain === 'nem'）は、同じ作りで中身だけ NEM 用になる。
//   - `facade` は NemFacade、SDK の名前は symbol-sdk/nem のもの（models / descriptors / Address / KeyPair …）、`sdkNem` で名前空間ごと使える。
//   - `NODE` は NIS1 のノード。署名済みトランザクションは POST /transaction/announce、確認は GET /transaction/get?hash=… で行う。
//   - `wallet` は address / publicKey / signTransaction / messageEncoder()。NEM に連署用のメソッド（cosign）は無い。
//   - wallet.messageEncoder().encode() は、NanoWallet などの NEM ウォレットが読める形式（AES-CBC）で暗号化する。返るのは SDK と同じ Message。
import * as core from 'symbol-sdk';
import * as nemSdk from 'symbol-sdk/nem';
import * as sym from 'symbol-sdk/symbol';
import { keccak_256, sha3_256, sha3_512 } from '@noble/hashes/sha3.js';
import { NEM_NETWORKS } from '../nem/constants';
import { bytesToHex, hexToBytes } from '../symbol/crypto';
import { getNetworkConfig } from '../symbol/network';
import { classifyDataSignature } from './dataSignGuard';
import { formatArgs } from './format';
import { checkOutboundUrl } from './netPolicy';
import type { NetworkProtections } from '../../store/consoleSettingsStore';
import { Interpreter, blockingFunction, isProtected, protect } from './interpreter';

export type LogKind = 'log' | 'info' | 'warn' | 'error';

/** ウォレットの鍵を使うお願い（署名・暗号化・復号）。確認ダイアログに見せる材料。 */
export interface SignRequest {
  /**
   * transaction: トランザクションへの署名 / cosignature: 連署（トランザクションのハッシュへの署名） / data: 任意のバイト列への署名
   * encrypt: メッセージの暗号化（wallet.messageEncoder().encode）/ decrypt: 暗号文の復号（wallet.messageEncoder().tryDecode）
   */
  kind: 'transaction' | 'cosignature' | 'data' | 'encrypt' | 'decrypt';
  /** 署名するバイト列 / 暗号化する中身 / 復号する暗号文（メッセージ欄そのまま） */
  data: Uint8Array;
  /** 署名するトランザクション全体（シリアライズ、16進）。分かるときだけ。 */
  payloadHex?: string;
  /** encrypt / decrypt: 相手の公開鍵（16進）。 */
  otherPublicKey?: string;
  /** walletKeyPair.sign(bytes)（任意のバイト列への署名）で来たが、トランザクションとして読めた。確認画面でその旨を見せる。 */
  viaRawSign?: boolean;
  /** data: ちょうど32バイト。連署（トランザクションのハッシュへの署名）と同じ形なので、確認画面で強く警告する。 */
  looksLikeHash?: boolean;
}

/**
 * 確認を取って、結果を返す。断られたら投げる。
 * 署名: 署名（64バイト）/ encrypt: 暗号化されたメッセージ（種別バイトつき）/ decrypt: 復号した中身。復号できなかったときだけ null。
 * 鍵そのものは、コードには返らない。
 */
export type SignHandler = (req: SignRequest) => Promise<Uint8Array | null>;

export type ConsoleChain = 'symbol' | 'nem';

export interface ConsoleEnvOptions {
  /** どちらのチェーンの環境か。省略は Symbol。 */
  chain?: ConsoleChain;
  networkByte: number;
  nodeUrl: string;
  /** ウォレットの署名アカウント（鍵を持つもの）。無ければ walletKeyPair / walletAddress は用意しない。 */
  signer: { publicKey: string } | null;
  onLog: (kind: LogKind, text: string) => void;
  onClear: () => void;
  onSign: SignHandler;
  /** 通信を制限するか（設定）。呼ぶたびに読むので、実行中に切り替えても効く。省略は、制限する。 */
  limitNetwork?: () => boolean;
  /** 通信の保護（URL内のユーザー名・パスワード／Cookie／参照元）。呼ぶたびに読む。省略は、すべて保護する。 */
  protections?: () => NetworkProtections;
}

export interface ConsoleEnv {
  interpreter: Interpreter;
  /** 動いているタイマーと WebSocket を止める（「停止」「リセット」、ページを離れるとき）。 */
  dispose(): void;
}

/** コードに渡す専用のFacade。ウォレット本体が使うキャッシュ済みのものは渡さない（書き換えられると署名の処理が乗っ取られるため）。 */
function newFacade(networkByte: number): sym.SymbolFacade {
  if (networkByte === 0x68) return new sym.SymbolFacade('mainnet');
  if (networkByte === 0x98) return new sym.SymbolFacade('testnet');
  const cfg = getNetworkConfig('mijin');
  const known = cfg.networkByte === networkByte && cfg.generationHash !== '';
  const hash = known ? cfg.generationHash : '0'.repeat(64);
  const epoch = known ? cfg.epochAdjustment : 0;
  return new sym.SymbolFacade(new sym.Network('mijin', networkByte, new Date(epoch * 1000), new core.Hash256(hash)));
}

/** NEM（NIS1）用の専用Facade。メインネット(0x68)・テストネット(0x98)だけ（NEM に mijin は無い）。 */
function newNemFacade(networkByte: number): nemSdk.NemFacade {
  return new nemSdk.NemFacade(networkByte === 0x98 ? 'testnet' : 'mainnet');
}

const isClass = (v: unknown): boolean => typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v));

// 署名が要るメソッド。ウォレットの鍵のときだけ、確認を挟む。
const MEDIATED: { name: string; kind: SignRequest['kind'] }[] = [
  { name: 'signTransaction', kind: 'transaction' },
  { name: 'cosignTransaction', kind: 'cosignature' },
  { name: 'cosignTransactionHash', kind: 'cosignature' },
];

export function createConsoleEnv(opts: ConsoleEnvOptions): ConsoleEnv {
  const isNem = opts.chain === 'nem';
  const interp = new Interpreter();
  const timers = new Set<number>();
  const sockets = new Set<WebSocket>();

  // --- ウォレットの鍵（秘密鍵は持たない。署名のたびに確認を挟む） ---
  const walletPublicKey = opts.signer ? new core.PublicKey(opts.signer.publicKey) : null;
  /** 署名のお願い。署名（バイト列）が返らなければエラー。 */
  const askSignature = async (req: SignRequest): Promise<Uint8Array> => {
    const sig = await opts.onSign(req);
    if (sig === null) throw new Error('signing failed');
    return sig;
  };
  // 署名するバイト列に生成ハッシュ（Symbol）を付けるので、メインネット・テストネット・いまのネットワークのものを「トランザクションの印」として知っておく。
  const knownGenerationHashes = (): Uint8Array[] => {
    const out: Uint8Array[] = [];
    const add = (b: unknown) => { if (b instanceof Uint8Array && b.length === 32) out.push(new Uint8Array(b)); };
    for (const f of [realFacade, new sym.SymbolFacade('mainnet'), new sym.SymbolFacade('testnet')]) {
      try { add((f as unknown as { network?: { generationHashSeed?: { bytes?: unknown } } }).network?.generationHashSeed?.bytes); } catch { /* 取れなければ設定のほうを使う */ }
    }
    for (const net of ['mainnet', 'testnet', 'mijin'] as const) {
      try {
        const hex = getNetworkConfig(net).generationHash;
        if (/^[0-9a-fA-F]{64}$/.test(hex)) add(hexToBytes(hex));
      } catch { /* 設定が無いネットワークは飛ばす */ }
    }
    return out;
  };
  /** 署名のとき SDK が実際に署名するバイト列を、署名をせずに取り出す（鍵の代わりに、受け取るだけの偽物を渡す）。 */
  const captureSigningBytes = (sign: (probe: { publicKey: unknown; sign: (d: Uint8Array) => unknown }) => unknown): Uint8Array => {
    const box: { data: Uint8Array | null } = { data: null };
    sign({ publicKey: walletPublicKey, sign: (d: Uint8Array) => { box.data = new Uint8Array(d); return new core.Signature(new Uint8Array(64)); } });
    if (box.data === null) throw new Error('no signature was requested');
    return box.data;
  };
  const rawSign = blockingFunction('sign', async (_t, args) => {
    const data = args[0];
    if (!(data instanceof Uint8Array)) throw new TypeError('sign() takes a Uint8Array');
    const bytes = new Uint8Array(data);
    // トランザクションを「データ」として署名させて、確認画面の目をすり抜けさせない。読み直して、トランザクションなら送金先や金額を見せる。
    const verdict = classifyDataSignature(bytes, {
      isNem,
      generationHashes: isNem ? [] : knownGenerationHashes(),
      signerPublicKey: walletPublicKey === null ? new Uint8Array(32) : walletPublicKey.bytes,
      deriveSymbolSigningBytes: (full) => {
        const tx = sym.models.TransactionFactory.deserialize(full);
        return captureSigningBytes((probe) => (realFacade as sym.SymbolFacade).signTransaction(probe as never, tx));
      },
      reserializeNem: (b) => nemSdk.models.NonVerifiableTransactionFactory.deserialize(b).serialize(),
    });
    if (verdict.verdict === 'refuse') throw new Error(`[console] sign() refused: ${verdict.reason}. To sign a transaction, use wallet.signTransaction(tx).`);
    const request: SignRequest = verdict.verdict === 'transaction'
      ? { kind: 'transaction', data: bytes, payloadHex: verdict.payloadHex, viaRawSign: true }
      : { kind: 'data', data: bytes, ...(verdict.verdict === 'hash32' ? { looksLikeHash: true } : {}) };
    const sig = await askSignature(request);
    return new core.Signature(sig);
  });
  const walletKeyPair = walletPublicKey ? Object.freeze({ publicKey: walletPublicKey, sign: rawSign }) : null;

  // --- 署名の確認（facade.signTransaction(walletKeyPair, …) と wallet.signTransaction(…) の両方で使う） ---
  // original: 本物の Facade のメソッド。args[0] が鍵（ウォレットの鍵なら確認を挟み、自分で作った鍵ならそのまま署名する）。
  function mediate(name: string, kind: SignRequest['kind'], original: (...a: unknown[]) => unknown, args: unknown[]): unknown {
    const method = original;
    const [keyPair, ...rest] = args;
    if (walletKeyPair === null || keyPair !== walletKeyPair) return method(keyPair, ...rest); // 自分で作った鍵は、そのまま署名する
    // SDK がちょうど何を署名するかは、SDK に聞く（鍵の代わりに、署名するバイト列を受け取るだけの偽物を渡す）。
    const box: { data: Uint8Array | null } = { data: null };
    const probe = {
      publicKey: walletPublicKey,
      sign: (data: Uint8Array) => { box.data = new Uint8Array(data); return new core.Signature(new Uint8Array(64)); },
    };
    method(probe, ...rest);
    const captured = box.data;
    if (captured === null) throw new Error(`${name}() did not ask for a signature`);
    const tx = rest[0] as { serialize?: () => Uint8Array } | undefined;
    // Symbol: 確認ダイアログには、トランザクション全体（署名つきの形）を見せる。
    // NEM: 署名するバイト列そのものがトランザクションの中身（署名欄を含まない形）なので、それを見せる。
    const payloadHex = kind === 'data' ? undefined : isNem ? bytesToHex(captured) : tx && typeof tx.serialize === 'function' ? bytesToHex(tx.serialize()) : undefined;
    return askSignature({ kind, data: captured, payloadHex }).then(
      // 確認が取れた署名を、同じ呼び出しにそのまま差し込む（SDK が署名つきの結果を組み立てる）。
      (signature) => method({ publicKey: walletPublicKey, sign: () => new core.Signature(signature) }, ...rest),
    );
  }

  // --- Facade（署名のところだけ確認を挟む） ---
  function wrapFacade<T extends object>(real: T): T {
    const mediated = new Map<string, unknown>();
    for (const { name, kind } of MEDIATED) {
      const original = (real as unknown as Record<string, unknown>)[name];
      if (typeof original !== 'function') continue;
      const method = (original as (...a: unknown[]) => unknown).bind(real);
      mediated.set(name, blockingFunction(name, async (_t, args) => mediate(name, kind, method, args)));
    }
    return new Proxy(real, {
      get(target, prop) {
        if (typeof prop === 'string' && mediated.has(prop)) return mediated.get(prop);
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' && !isClass(v) ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
  }

  // new SymbolFacade('testnet') / new NemFacade('testnet') と書かれても、確認つきの Facade が返るようにする。
  const facadeName = isNem ? 'NemFacade' : 'SymbolFacade';
  const ConsoleChainFacade = new Proxy((isNem ? nemSdk.NemFacade : sym.SymbolFacade) as new (...a: never[]) => object, {
    construct(target, args) { return wrapFacade(Reflect.construct(target, args) as object); },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });

  const chainModule: Record<string, unknown> = isNem ? { ...nemSdk } : { ...sym };
  const sdkCore: Record<string, unknown> = { ...core };
  // sdkSymbol（Symbol のとき）/ sdkNem（NEM のとき）: そのチェーンの SDK。
  const sdkChain: Record<string, unknown> = { ...chainModule, [facadeName]: ConsoleChainFacade };
  const sdk: Record<string, unknown> = { ...core, [isNem ? 'nem' : 'symbol']: sdkChain };
  protect(core, 3);
  protect(isNem ? nemSdk : sym, 3);
  protect(sdkCore, 0);
  protect(sdkChain, 0);
  protect(sdk, 0);

  // --- 組み込み（必要なものだけ渡す） ---
  const guardedAssign = (target: unknown, ...sources: unknown[]) => {
    if (target === null || target === undefined) throw new TypeError('Cannot convert undefined or null to object');
    if (isProtected(target)) throw new TypeError('[console] this built-in object is read-only');
    return Object.assign(target as object, ...sources);
  };
  const SafeObject = function ObjectLike(value?: unknown): object { return Object(value) as object; } as unknown as Record<string, unknown>;
  Object.defineProperty(SafeObject, 'prototype', { value: Object.prototype });
  Object.assign(SafeObject, {
    keys: Object.keys, values: Object.values, entries: Object.entries, fromEntries: Object.fromEntries, hasOwn: Object.hasOwn, is: Object.is,
    getOwnPropertyNames: Object.getOwnPropertyNames, isFrozen: Object.isFrozen, create: (proto: object | null) => Object.create(proto) as object,
    assign: guardedAssign,
    freeze: (o: unknown) => { if (isProtected(o)) throw new TypeError('[console] this built-in object is read-only'); return Object.freeze(o); },
  });

  const consoleObj = Object.freeze({
    log: (...a: unknown[]) => opts.onLog('log', formatArgs(a)),
    info: (...a: unknown[]) => opts.onLog('info', formatArgs(a)),
    debug: (...a: unknown[]) => opts.onLog('log', formatArgs(a)),
    dir: (...a: unknown[]) => opts.onLog('log', formatArgs(a)),
    warn: (...a: unknown[]) => opts.onLog('warn', formatArgs(a)),
    error: (...a: unknown[]) => opts.onLog('error', formatArgs(a)),
    clear: () => opts.onClear(),
  });

  // 自分の PC・LAN への通信は止める（netPolicy.ts）。いま使っているノードだけは通す。NODE は書き換えられるので、最初のURLを覚えておく。
  const ownNodeUrl = opts.nodeUrl;
  const isLimited = (): boolean => (opts.limitNetwork ? opts.limitNetwork() : true);
  const getProtections = (): NetworkProtections => (opts.protections ? opts.protections() : { blockUrlCredentials: true, omitCookies: true, hideReferrer: true });
  const safeFetch = (input: unknown, init?: RequestInit): Promise<Response> => {
    const limited = isLimited();
    const prot = getProtections();
    let url: string;
    try { url = checkOutboundUrl(input, ['http:', 'https:'], ownNodeUrl, !limited, !prot.blockUrlCredentials); } catch (e) { return Promise.reject(e instanceof Error ? e : new TypeError(String(e))); }
    // Cookie と参照元は、初期設定では送らない（コードが指定しても上書きする）。設定でオフにした項目だけ、コードの指定（なければブラウザの既定）に従う。
    // 制限ありのときは、転送（リダイレクト）の先が内部向けかを確かめられないので追わない。
    return fetch(url, {
      ...(init ?? {}),
      ...(prot.omitCookies ? { credentials: 'omit' as const } : {}),
      ...(prot.hideReferrer ? { referrerPolicy: 'no-referrer' as const } : {}),
      ...(limited ? { redirect: 'error' as const } : {}),
    });
  };

  function ConsoleWebSocket(url: unknown, protocols?: string | string[]): WebSocket {
    const u = checkOutboundUrl(url, ['ws:', 'wss:'], ownNodeUrl, !isLimited(), !getProtections().blockUrlCredentials);
    const ws = new WebSocket(u, protocols);
    sockets.add(ws);
    ws.addEventListener('close', () => sockets.delete(ws));
    return ws;
  }
  Object.assign(ConsoleWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  const startTimer = (repeat: boolean) => (handler: unknown, ms?: unknown, ...args: unknown[]): number => {
    if (typeof handler !== 'function') throw new TypeError('the timer callback must be a function');
    const run = () => { (handler as (...a: unknown[]) => unknown)(...args); };
    const id = repeat ? window.setInterval(run, Number(ms) || 0) : window.setTimeout(() => { timers.delete(id); run(); }, Number(ms) || 0);
    timers.add(id);
    return id;
  };
  const stopTimer = (id: unknown) => {
    if (typeof id !== 'number') return;
    timers.delete(id);
    window.clearTimeout(id);
    window.clearInterval(id);
  };

  const randomSource = Object.freeze({
    getRandomValues: <T extends ArrayBufferView>(a: T): T => crypto.getRandomValues(a as never) as T,
    randomUUID: () => crypto.randomUUID(),
  });

  const builtins: Record<string, unknown> = {
    Object: SafeObject, Array, String, Number, Boolean, BigInt, Symbol, Math, JSON, Date, RegExp, Map, Set, WeakMap, WeakSet, Promise,
    Error, TypeError, RangeError, SyntaxError, ReferenceError,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, BigUint64Array, BigInt64Array, Float64Array, ArrayBuffer, DataView,
    TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    btoa: (s: string) => btoa(s), atob: (s: string) => atob(s),
    console: consoleObj, crypto: randomSource, fetch: safeFetch, WebSocket: ConsoleWebSocket,
    setTimeout: startTimer(false), setInterval: startTimer(true), clearTimeout: stopTimer, clearInterval: stopTimer,
  };
  for (const [k, v] of Object.entries(builtins)) {
    interp.defineGlobal(k, v);
    protect(v, 1);
  }
  // SDK の名前（PrivateKey, models, generateMosaicId …）。JS の組み込みと同じ名前があれば、組み込みを優先する。
  for (const [k, v] of Object.entries(sdkCore)) if (!interp.hasGlobal(k)) interp.defineGlobal(k, v);
  for (const [k, v] of Object.entries(sdkChain)) if (!interp.hasGlobal(k) || k === facadeName) interp.defineGlobal(k, v);
  interp.defineGlobal('sdk', sdk);
  interp.defineGlobal('sdkCore', sdkCore);
  interp.defineGlobal(isNem ? 'sdkNem' : 'sdkSymbol', sdkChain);

  // 速習Symbol のコードにある `await import("https://…/symbol-sdk@…/bundle.web.js")` は、同梱のSDKを返す。ほかは読み込まない。
  // import 文（`import { SymbolFacade } from 'symbol-sdk/symbol'` など）も同じ。'symbol-sdk/symbol'（NEM のときは 'symbol-sdk/nem'）は
  // いま使っているチェーンの名前空間、'symbol-sdk' は全体。もう一方のチェーンの名前空間は渡さない。
  // 速習Symbol のシークレットロック・検証の章にある `await import('https://cdn.skypack.dev/@noble/hashes/sha3')` は、同梱の SHA3（sha3_256 / sha3_512）を返す。
  // NEM のトランザクションのハッシュは Keccak-256（SHA3 とはパディングが違う）なので、NEM のペイロードの検証サンプル用に keccak_256 も入れてある。
  // 外の URL は読み込まない。ほかの @noble/hashes のファイルは、このコンソールでは使えない。
  const nobleSha3 = Object.freeze({ sha3_256, sha3_512, keccak_256 });
  interp.importHandler = async (specifier) => {
    if (/@noble\/hashes\/sha3(\.js)?(\?.*)?$/i.test(specifier)) return nobleSha3;
    if (/symbol-sdk\/(symbol|nem)(\/|$)/i.test(specifier)) {
      if (new RegExp(`symbol-sdk/${isNem ? 'nem' : 'symbol'}(/|$)`, 'i').test(specifier)) return sdkChain;
      throw new Error(`import() of "${specifier}" is not available in the ${isNem ? 'NEM' : 'Symbol'} console`);
    }
    if (/symbol-sdk/i.test(specifier)) return sdk;
    throw new Error(`import() is limited to symbol-sdk in this console (got "${specifier}"). The SDK is already loaded.`);
  };

  // --- ふだん使う変数（コードから書き換えてよい） ---
  const realFacade = (isNem ? newNemFacade(opts.networkByte) : newFacade(opts.networkByte)) as sym.SymbolFacade & nemSdk.NemFacade;
  const facade = wrapFacade(realFacade);
  interp.defineGlobal('facade', facade);
  interp.defineGlobal('NODE', opts.nodeUrl);
  // 速習Symbol の「事前準備」で作る変数のうち、ネットワークから分かるもの
  interp.defineGlobal('networkType', opts.networkByte);
  interp.defineGlobal('identifier', opts.networkByte === 0x68 ? 'mainnet' : opts.networkByte === 0x98 ? 'testnet' : 'mijin');
  // clog(tx): アナウンスしたトランザクションを確認するためのURLを出す（速習Symbol 2.3）
  interp.defineGlobal('clog', (signedTx: unknown) => {
    const node = String(interp.getGlobal('NODE'));
    if (isNem) {
      // NEM は、署名の前後でハッシュが変わらない（署名欄を除いた部分のハッシュ）。
      const hash = facade.hashTransaction(signedTx as Parameters<nemSdk.NemFacade['hashTransaction']>[0]).toString().toLowerCase();
      const explorer = Object.values(NEM_NETWORKS).find((n) => n.networkByte === opts.networkByte)?.explorer ?? NEM_NETWORKS.mainnet.explorer;
      opts.onLog('log', `${node}/transaction/get?hash=${hash}`);
      opts.onLog('log', opts.networkByte === 0x98 ? `${explorer}/tx/${hash}` : `${explorer}/#/s_tx?hash=${hash}`);
      return;
    }
    const hash = facade.hashTransaction(signedTx as Parameters<sym.SymbolFacade['hashTransaction']>[0]).toString();
    for (const url of [`${node}/transactionStatus/${hash}`, `${node}/transactions/confirmed/${hash}`, `https://symbol.fyi/transactions/${hash}`, `https://testnet.symbol.fyi/transactions/${hash}`]) {
      opts.onLog('log', url);
    }
  });
  if (walletKeyPair !== null && walletPublicKey !== null) {
    const address = facade.network.publicKeyToAddress(walletPublicKey);
    interp.defineGlobal('walletKeyPair', walletKeyPair);
    interp.defineGlobal('walletAddress', address);
    // wallet.messageEncoder(): 暗号化メッセージ。暗号化・復号のたびに、内容を見せる確認ダイアログとパスワード入力を挟む。
    // 鍵はコードに渡さない。返るのは、暗号文（encode）か、復号した中身（tryDecode）だけ。
    const toPublicKeyHex = (v: unknown): string => {
      const hex = v instanceof core.PublicKey ? v.toString() : typeof v === 'string' ? v : '';
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new TypeError('the other side must be a PublicKey (or a 64-digit hex string)');
      return hex.toUpperCase();
    };
    const symbolMessageEncoder = Object.freeze({
      publicKey: walletPublicKey,
      encode: blockingFunction('encode', async (_t, args) => {
        const [other, message] = args;
        const data = typeof message === 'string' ? new TextEncoder().encode(message) : message;
        if (!(data instanceof Uint8Array)) throw new TypeError('encode() takes a PublicKey and a Uint8Array (or a string)');
        const encoded = await opts.onSign({ kind: 'encrypt', data: new Uint8Array(data), otherPublicKey: toPublicKeyHex(other) });
        if (encoded === null) throw new Error('encryption failed');
        return encoded;
      }),
      // SDK と同じ形 { isDecoded, message } を返す。復号できなければ isDecoded: false と、元の暗号文。
      tryDecode: blockingFunction('tryDecode', async (_t, args) => {
        const [other, encoded] = args;
        if (!(encoded instanceof Uint8Array)) throw new TypeError('tryDecode() takes a PublicKey and a Uint8Array');
        const plain = await opts.onSign({ kind: 'decrypt', data: new Uint8Array(encoded), otherPublicKey: toPublicKeyHex(other) });
        return plain === null ? { isDecoded: false, message: encoded } : { isDecoded: true, message: plain };
      }),
    });
    // NEM: SDK の NEM の MessageEncoder と同じ形（encode は Message を返し、tryDecode は Message を受け取る）。
    // 暗号文は、NanoWallet などの NEM ウォレットが読める形式（ダイアログ側で作る）。bob.messageEncoder()（SDK）の tryDecode も読める。
    const nemMessageEncoder = Object.freeze({
      publicKey: walletPublicKey,
      encode: blockingFunction('encode', async (_t, args) => {
        const [other, message] = args;
        const data = typeof message === 'string' ? new TextEncoder().encode(message) : message;
        if (!(data instanceof Uint8Array)) throw new TypeError('encode() takes a PublicKey and a Uint8Array (or a string)');
        const payload = await opts.onSign({ kind: 'encrypt', data: new Uint8Array(data), otherPublicKey: toPublicKeyHex(other) });
        if (payload === null) throw new Error('encryption failed');
        const encoded = new nemSdk.models.Message();
        encoded.messageType = nemSdk.models.MessageType.ENCRYPTED;
        encoded.message = Uint8Array.from(payload);
        return encoded;
      }),
      // SDK と同じ形 { isDecoded, message } を返す。復号できなければ isDecoded: false と、元の Message。
      tryDecode: blockingFunction('tryDecode', async (_t, args) => {
        const [other, encoded] = args;
        const holder = encoded as { message?: unknown; messageType?: { value?: number } } | null;
        const bytes = encoded instanceof Uint8Array ? encoded : holder?.message;
        if (!(bytes instanceof Uint8Array)) throw new TypeError('tryDecode() takes a PublicKey and a Message (or a Uint8Array)');
        if (!(encoded instanceof Uint8Array) && holder?.messageType?.value !== nemSdk.models.MessageType.ENCRYPTED.value) return { isDecoded: false, message: encoded };
        const plain = await opts.onSign({ kind: 'decrypt', data: new Uint8Array(bytes), otherPublicKey: toPublicKeyHex(other) });
        return plain === null ? { isDecoded: false, message: encoded } : { isDecoded: true, message: plain };
      }),
    });
    // wallet: SymbolAccount / NemAccount（facade.createAccount(...) の戻り値）と同じ使い方ができる、ウォレットのアカウント。署名は確認ダイアログを挟む。
    const realMethod = (name: string) => (realFacade as unknown as Record<string, (...a: unknown[]) => unknown>)[name].bind(realFacade);
    const accountMethod = (name: string, kind: SignRequest['kind']) =>
      blockingFunction(name, async (_t, args) => mediate(name, kind, realMethod(name), [walletKeyPair, ...args]));
    const walletAccount = Object.freeze(isNem ? {
      address,
      publicKey: walletPublicKey,
      keyPair: walletKeyPair,
      signTransaction: accountMethod('signTransaction', 'transaction'),
      messageEncoder: () => nemMessageEncoder,
    } : {
      address,
      publicKey: walletPublicKey,
      keyPair: walletKeyPair,
      signTransaction: accountMethod('signTransaction', 'transaction'),
      cosignTransaction: accountMethod('cosignTransaction', 'cosignature'),
      cosignTransactionHash: accountMethod('cosignTransactionHash', 'cosignature'),
      messageEncoder: () => symbolMessageEncoder,
    });
    // `alice`（速習Symbol の、自分のアカウント）も同じもの。`wallet` でも書ける。alice = facade.createAccount(...) と代入すれば、alice は自分で作った鍵に替わる（wallet はそのまま）。
    interp.defineGlobal('wallet', walletAccount);
    interp.defineGlobal('alice', walletAccount);
  }

  const dispose = () => {
    for (const id of timers) { window.clearTimeout(id); window.clearInterval(id); }
    timers.clear();
    for (const ws of sockets) { try { ws.close(); } catch { /* 閉じられなくても続ける */ } }
    sockets.clear();
  };
  return { interpreter: interp, dispose };
}
