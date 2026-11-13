import dingUrl from '../assets/ding.ogg';
import ding2Url from '../assets/ding2.ogg';
import dingClassicUrl from '../assets/ding-classic.ogg';
import ding2ClassicUrl from '../assets/ding2-classic.ogg';
import dingSoftUrl from '../assets/ding-soft.ogg';
import ding2SoftUrl from '../assets/ding2-soft.ogg';

/**
 * 通知音の種類（表示名は i18n の settings.live_sound_theme_*）。
 * 'default' = 「KASANE チャイム」（KASANE の標準の音。保存済みの設定との互換のため、キーは default のまま）、
 * 'soft' = 「ソフトベル」（やわらかい低めのベル）、
 * 'classic' = 「クラシック」（これまでの音。公式 Symbol Desktop Wallet 1.2.0 の ding.ogg、Apache-2.0）。
 * どれも2つで1組：started = 取引が始まった（ノードに通知された）とき、confirmed = 承認されたとき。
 */
export type LiveSoundTheme = 'default' | 'soft' | 'classic';
export const LIVE_SOUND_THEMES: readonly LiveSoundTheme[] = ['default', 'soft', 'classic'];
export const DEFAULT_LIVE_SOUND_THEME: LiveSoundTheme = 'default';

export const isLiveSoundTheme = (v: unknown): v is LiveSoundTheme => v === 'default' || v === 'soft' || v === 'classic';

const URLS: Record<LiveSoundTheme, { started: string; confirmed: string }> = {
  default: { started: dingUrl, confirmed: ding2Url },
  soft: { started: dingSoftUrl, confirmed: ding2SoftUrl },
  classic: { started: dingClassicUrl, confirmed: ding2ClassicUrl },
};

// One player per sound, kept so a repeated sound does not load the file again.
const players = new Map<string, HTMLAudioElement>();

/** Plays one sound of a theme. Browsers refuse sound before the first tap on the page; that is fine, it is just skipped. */
export function playLiveSound(theme: LiveSoundTheme, kind: 'started' | 'confirmed'): void {
  try {
    const url = URLS[theme][kind];
    let player = players.get(url);
    if (!player) {
      player = new Audio(url);
      players.set(url, player);
    }
    player.currentTime = 0;
    void player.play().catch(() => undefined);
  } catch { /* no audio support */ }
}
