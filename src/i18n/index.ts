import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import messages from './messages.json';
// zh / ko / ru are kept in separate files so they can be filled in incrementally: any key that
// is not translated yet falls back to English (see fallbackLng below), never to a raw key.
import zh from './zh.json';
import ko from './ko.json';
import ru from './ru.json';
import { LANGUAGES } from './languages';

// messages.json is carried over verbatim from the Vue app (vue-i18n's format is a plain
// { locale: { namespace: { key: value } } } object, which react-i18next's resources shape
// also accepts directly — no conversion needed).
i18n
  .use(initReactI18next)
  .init({
    resources: {
      ja: { translation: messages.ja },
      en: { translation: messages.en },
      zh: { translation: zh },
      ko: { translation: ko },
      ru: { translation: ru },
    },
    lng: 'ja',
    fallbackLng: { zh: ['en', 'ja'], ko: ['en', 'ja'], ru: ['en', 'ja'], default: ['en', 'ja'] },
    interpolation: {
      escapeValue: false,
    },
  });

// Keep <html lang> in sync so the browser picks the right CJK glyph set / hyphenation.
i18n.on('languageChanged', (lng) => {
  const htmlLang = LANGUAGES.find((l) => l.code === lng)?.htmlLang ?? lng;
  document.documentElement.lang = htmlLang;
});

export default i18n;
