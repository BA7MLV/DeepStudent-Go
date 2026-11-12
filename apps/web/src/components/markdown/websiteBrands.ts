import {
  IconBrandBaidu, IconBrandBilibili, IconBrandFigma, IconBrandGithub,
  IconBrandGoogle, IconBrandNotion, IconBrandOpenai, IconBrandSlack,
  IconBrandStackoverflow, IconBrandWechat, IconBrandWikipedia,
  IconBrandYoutube, IconBrandZhihu,
} from '@tabler/icons-react';

// Existing MIT-licensed Tabler brand glyphs are bundled with the application:
// no external logo API, image download, or separate icon package is needed.
const BRANDS = [
  { id: 'github', hosts: ['github.com'], Icon: IconBrandGithub },
  { id: 'bilibili', hosts: ['bilibili.com', 'b23.tv'], Icon: IconBrandBilibili },
  { id: 'zhihu', hosts: ['zhihu.com'], Icon: IconBrandZhihu },
  { id: 'baidu', hosts: ['baidu.com'], Icon: IconBrandBaidu },
  { id: 'wechat', hosts: ['weixin.qq.com'], Icon: IconBrandWechat },
  { id: 'notion', hosts: ['notion.com', 'notion.so'], Icon: IconBrandNotion },
  { id: 'figma', hosts: ['figma.com'], Icon: IconBrandFigma },
  { id: 'slack', hosts: ['slack.com'], Icon: IconBrandSlack },
  { id: 'wikipedia', hosts: ['wikipedia.org'], Icon: IconBrandWikipedia },
  { id: 'stackoverflow', hosts: ['stackoverflow.com'], Icon: IconBrandStackoverflow },
  { id: 'youtube', hosts: ['youtube.com', 'youtu.be'], Icon: IconBrandYoutube },
  { id: 'google', hosts: ['google.com'], Icon: IconBrandGoogle },
  { id: 'openai', hosts: ['openai.com', 'chatgpt.com'], Icon: IconBrandOpenai },
];

export function websiteBrand(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return BRANDS.find(brand => brand.hosts.some(domain => host === domain || host.endsWith(`.${domain}`))) ?? null;
}
