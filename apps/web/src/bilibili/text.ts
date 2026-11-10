import i18n from '../i18n';
import type projects from '../i18n/locales/zh-CN/projects.json';

export function biliText(key: keyof typeof projects.biliLocal, values: Record<string, string | number> = {}): string {
  return i18n.t(`projects:biliLocal.${key}` as const, values);
}
