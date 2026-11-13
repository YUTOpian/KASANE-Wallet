// コンソールの Worker（consoleWorker.ts）とメインスレッド（consoleRunner.ts）がやり取りするメッセージ。
// どちらも structured clone で送れるものだけ（関数・クラスのインスタンスは送らない）。
import type { LogKind, ConsoleChain, SignRequest } from './env';
import type { ConsoleLang } from './tsStrip';
import type { MijinParams } from '../symbol/network';

export interface NetworkProtectionsSnapshot { blockUrlCredentials: boolean; omitCookies: boolean; hideReferrer: boolean }

/** 通信まわりの設定。実行中に切り替えても効くよう、変わるたびに送り直す。 */
export interface SettingsSnapshot { limitNetwork: boolean; protections: NetworkProtectionsSnapshot }

/** Error を送れる形にしたもの。 */
export type WireError =
  | { kind: 'stop' }
  | { kind: 'error'; name: string; message: string; loc?: { line: number; column: number } }
  /** Error ではない値を throw した（`throw 'x'`、`throw { a: 1 }`）。表示用に整形した文字列。 */
  | { kind: 'value'; text: string };

export type ToWorker =
  | { type: 'init'; chain: ConsoleChain; networkByte: number; nodeUrl: string; signer: { publicKey: string } | null; mijin: MijinParams | null; settings: SettingsSnapshot }
  | { type: 'settings'; settings: SettingsSnapshot }
  | { type: 'run'; id: number; source: string; lang: ConsoleLang }
  /** 協調的な停止（変数は残る）。応答がなければ、メイン側が Worker ごと止める。 */
  | { type: 'stop' }
  | { type: 'signResult'; id: number; sig: Uint8Array | null; error?: string };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'log'; kind: LogKind; text: string }
  | { type: 'clear' }
  | { type: 'sign'; id: number; req: SignRequest }
  | { type: 'done'; id: number; hasValue: boolean; undef: boolean; text: string; line: number }
  | { type: 'fail'; id: number; error: WireError; line: number }
  /** コールバック（タイマー・イベント）の中で起きて、run の外へ漏れたエラー。 */
  | { type: 'uncaught'; error: WireError };
