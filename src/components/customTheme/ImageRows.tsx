import { useRef, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useTranslation } from 'react-i18next';
import { IMAGE_SLOTS, MAX_ALL_IMAGE_CHARS, MAX_TOTAL_IMAGE_CHARS, imageCharsOf, slotOf } from '../../theme/customTheme';
import type { ImageKey, ImageSlot, SavedCustomTheme } from '../../theme/customTheme';
import { ImageError, processImage } from '../../theme/imageProcessing';
import { setImage } from '../../theme/themeDraft';
import type { EditorTheme } from '../../theme/themeDraft';

// 画像を1枚ずつ選ぶ行（かんたん）。選んだ画像は、編集中のテーマに入る（保存は、ダイアログの「保存して使う」）。
export function useImagePicker(ed: EditorTheme, themes: SavedCustomTheme[], update: (fn: (ed: EditorTheme) => EditorTheme) => void) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingKey = useRef<ImageKey>('logoMark');
  const [busyKey, setBusyKey] = useState<ImageKey | null>(null);
  const [error, setError] = useState('');

  const pick = (key: ImageKey) => {
    pendingKey.current = key;
    inputRef.current?.click();
  };
  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const key = pendingKey.current;
    setError('');
    setBusyKey(key);
    try {
      const uri = await processImage(file, slotOf(key));
      const mine = imageCharsOf({ images: { ...ed.images, [key]: uri } });
      const others = themes.filter((th) => th.id !== ed.id).reduce((sum, th) => sum + imageCharsOf(th), 0);
      if (mine > MAX_TOTAL_IMAGE_CHARS || others + mine > MAX_ALL_IMAGE_CHARS) {
        setError(t('settings.custom_theme_image_error_total'));
        return;
      }
      update((cur) => setImage(cur, key, uri));
    } catch (e) {
      setError(t(`settings.custom_theme_image_error_${e instanceof ImageError ? e.code : 'decode'}`));
    } finally {
      setBusyKey(null);
    }
  };
  const remove = (key: ImageKey) => update((cur) => setImage(cur, key, null));
  const input = <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={onFile} />;
  return { pick, remove, busyKey, error, clearError: () => setError(''), input };
}

type Picker = ReturnType<typeof useImagePicker>;

// ja / en come with the slot itself (customTheme.ts); the other display languages are listed here by slot key.
type SlotLang = 'ja' | 'en' | 'zh' | 'ko' | 'ru';
const SLOT_LABELS: Record<'zh' | 'ko' | 'ru', Record<string, string>> = {
  zh: {
    logoMark: '徽标（六边形标志）：启动画面、对话框', logoWordmark: '徽标（KASANE 字样）：启动画面、侧边菜单', background: '背景图片', hero: '余额卡片图片',
    navHome: '主页', navAccount: '账户', navAddressbook: '通讯录', navMosaic: '马赛克', navNamespace: '命名空间', navMultisig: '多重签名',
    navHarvest: '收割', navAggregate: '聚合交易', navService: '服务（NEM）', navLinks: '链接集', navSettings: '设置',
  },
  ko: {
    logoMark: '로고(육각형 마크): 시작 화면·대화상자', logoWordmark: '로고(KASANE 글자): 시작 화면·사이드 메뉴', background: '배경 이미지', hero: '잔액 카드 이미지',
    navHome: '홈', navAccount: '계정', navAddressbook: '주소록', navMosaic: '모자이크', navNamespace: '네임스페이스', navMultisig: '멀티시그',
    navHarvest: '하베스팅', navAggregate: '애그리게이트', navService: '서비스(NEM)', navLinks: '링크 모음', navSettings: '설정',
  },
  ru: {
    logoMark: 'Логотип (шестиугольный знак): стартовый экран, диалоги', logoWordmark: 'Логотип (надпись KASANE): стартовый экран, боковое меню', background: 'Фоновое изображение', hero: 'Изображение карточки баланса',
    navHome: 'Главная', navAccount: 'Аккаунт', navAddressbook: 'Адресная книга', navMosaic: 'Мозаики', navNamespace: 'Пространства имён', navMultisig: 'Мультиподпись',
    navHarvest: 'Харвестинг', navAggregate: 'Агрегаты', navService: 'Сервисы (NEM)', navLinks: 'Ссылки', navSettings: 'Настройки',
  },
};
const slotLabel = (slot: ImageSlot, lang: SlotLang) => {
  if (lang === 'zh' || lang === 'ko' || lang === 'ru') return SLOT_LABELS[lang][slot.key] ?? slot.en.replace(/^[^：:]*[：:]\s*/, '');
  return slot.kind === 'icon' ? slot[lang].replace(/^[^：:]*[：:]\s*/, '') : slot[lang];
};
const slotLang = (language: string): SlotLang => {
  const code = language.slice(0, 2);
  return code === 'ja' || code === 'zh' || code === 'ko' || code === 'ru' ? code : 'en';
};

export function ImageRow({ slot, ed, picker }: { slot: ImageSlot; ed: EditorTheme; picker: Picker }) {
  const { t, i18n } = useTranslation();
  const lang = slotLang(i18n.language);
  const image = ed.images[slot.key];
  const busy = picker.busyKey === slot.key;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.75 }}>
      <Box
        sx={{
          width: 44, height: 44, flexShrink: 0, borderRadius: 1, border: 1, borderColor: 'divider', overflow: 'hidden',
          backgroundImage: 'repeating-conic-gradient(rgba(128,128,128,0.25) 0% 25%, transparent 0% 50%)', backgroundSize: '10px 10px',
        }}
      >
        {image && <Box component="img" src={image} alt="" sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />}
      </Box>
      <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }}>{slotLabel(slot, lang)}</Typography>
      {busy ? <CircularProgress size={20} /> : (
        <>
          <Button size="small" variant={image ? 'text' : 'outlined'} onClick={() => picker.pick(slot.key)} disabled={picker.busyKey !== null}>
            {image ? t('settings.custom_theme_image_change') : t('settings.custom_theme_image_pick')}
          </Button>
          {image && (
            <IconButton size="small" aria-label={t('settings.custom_theme_image_remove')} title={t('settings.custom_theme_image_remove')} onClick={() => picker.remove(slot.key)} disabled={picker.busyKey !== null}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          )}
        </>
      )}
    </Box>
  );
}

export const imageSlotsOf = (keys: ImageKey[]) => keys.map((k) => slotOf(k));
export const ICON_SLOTS = IMAGE_SLOTS.filter((s) => s.kind === 'icon');
