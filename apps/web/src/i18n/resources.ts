import commonZh from './locales/zh-CN/common.json';
import settingsZh from './locales/zh-CN/settings.json';
import projectsZh from './locales/zh-CN/projects.json';
import gatewayZh from './locales/zh-CN/gateway.json';
import botZh from './locales/zh-CN/bot.json';
import interfaceZh from './locales/zh-CN/interface.json';

/**
 * 只有回退语言(zh-CN)随入口打包:另一语言(en-US)改为动态 import(见 en-US.ts),
 * 从首屏省下约 25–30KB gzip;en-US chunk 进 SW 预缓存,离线切换语言仍可用。
 * 英文用户首次打开会先见一帧中文骨架,换语言 chunk 到达即切换,属可接受代价。
 */
export const resources = {
  'zh-CN': { common: commonZh, settings: settingsZh, projects: projectsZh, gateway: gatewayZh, bot: botZh, interface: interfaceZh },
} as const;
