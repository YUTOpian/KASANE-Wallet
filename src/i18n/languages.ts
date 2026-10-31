// The five official display languages. Each language's own name (endonym) is shown in its own
// script regardless of the current display language. `locale` is the BCP-47 tag used for
// Intl / toLocale*String formatting; `htmlLang` goes on <html lang> so CJK fonts pick the
// right glyph variants (Simplified Chinese vs Japanese Han, etc.).
export type AppLanguage = 'ja' | 'en' | 'zh' | 'ko' | 'ru';

export const LANGUAGES: { code: AppLanguage; label: string; locale: string; htmlLang: string }[] = [
  { code: 'ja', label: '日本語', locale: 'ja-JP', htmlLang: 'ja' },
  { code: 'en', label: 'English', locale: 'en-US', htmlLang: 'en' },
  { code: 'zh', label: '简体中文', locale: 'zh-CN', htmlLang: 'zh-CN' },
  { code: 'ko', label: '한국어', locale: 'ko-KR', htmlLang: 'ko' },
  { code: 'ru', label: 'Русский', locale: 'ru-RU', htmlLang: 'ru' },
];

export const localeOf = (code: AppLanguage): string => LANGUAGES.find((l) => l.code === code)?.locale ?? 'en-US';

/** i18n.language（'ja' や 'zh-CN' のように、地域が付くこともある）を、5つの表示言語のどれかにする。当てはまらなければ英語。 */
export const toAppLanguage = (language: string | undefined): AppLanguage => {
  const code = (language ?? '').slice(0, 2);
  return LANGUAGES.find((l) => l.code === code)?.code ?? 'en';
};
