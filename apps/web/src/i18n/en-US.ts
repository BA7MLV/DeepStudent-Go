import common from './locales/en-US/common.json';
import settings from './locales/en-US/settings.json';
import projects from './locales/en-US/projects.json';
import gateway from './locales/en-US/gateway.json';
import bot from './locales/en-US/bot.json';
import interface_ from './locales/en-US/interface.json';

/**
 * en-US 只被动态 import(见 index.ts 的 ensureResources):两套语言包各约 28–30KB gzip,
 * 全部打进入口对 zh 用户是纯损耗。该 chunk 会进 SW 预缓存,离线切换语言不受影响。
 */
export default { common, settings, projects, gateway, bot, interface: interface_ };
