
export class Environment {
  // Detects if device is on iOS
// Detects if device is in standalone mode
  static isIos(): boolean {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent);
  }

  // Detects if device is on Android
  static isAndroid(): boolean {
    return /android/.test(window.navigator.userAgent.toLowerCase());
  }

  // iPadOS 13+ asks for the desktop site by default and reports itself as a Mac: a "Mac" with a touch screen is an iPad.
  private static isIpadOsAsMac(): boolean {
    return window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
  }

  // モバイル表示にするか: iOS（iPhone / iPad / iPod）か Android からのアクセスなら true。画面の幅ではなく、端末で決める
  // （幅だけで決めると、デスクトップでウィンドウを狭くしただけでモバイルの画面になってしまう）。
  static isMobile(): boolean {
    try {
      return Environment.isIos() || Environment.isAndroid() || Environment.isIpadOsAsMac();
    } catch {
      return false;
    }
  }

  static isInStandaloneMode(): boolean {
    return ('standalone' in window.navigator) && ((window.navigator as any).standalone);
  }
}
