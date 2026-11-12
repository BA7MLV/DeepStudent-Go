import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES, type AppLocale } from './locale';
import { resources } from './resources';

const i18n: I18n = createInstance();
// 只有本地资源，没有异步 backend；导入后即可翻译启动错误。
void i18n.use(initReactI18next).init({
  resources,
  lng: FALLBACK_LOCALE,
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: [...SUPPORTED_LOCALES],
  load: 'currentOnly',
  defaultNS: 'common',
  ns: ['common', 'settings', 'projects'],
  initAsync: false,
  interpolation: { escapeValue: false }, // 文本转义交给 React，译文不作为 HTML 注入。
  react: { useSuspense: false },
});

const localeBundles: Partial<Record<AppLocale, () => Promise<{ default: Record<string, object> }>>> = {
  'en-US': () => import('./en-US'),
};
async function ensureResources(locale: AppLocale): Promise<void> {
  if (locale === FALLBACK_LOCALE || i18n.hasResourceBundle(locale, 'common')) return;
  const load = localeBundles[locale];
  if (!load) return;
  const { default: bundles } = await load();
  for (const [namespace, bundle] of Object.entries(bundles)) i18n.addResourceBundle(locale, namespace, bundle, true, true);
}

export function applyLocale(locale: AppLocale): Promise<void> {
  document.documentElement.lang = locale;
  document.documentElement.dir = i18n.dir(locale);
  // 非回退语言的文案在动态 chunk 里,到齐后再切换,避免一屏回退语言夹杂。
  return ensureResources(locale).then(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
    document.title = i18n.t('appTitle');
  });
}

export default i18n;
