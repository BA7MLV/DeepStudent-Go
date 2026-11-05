import type { ToolDef } from '../api/modelClient.ts';

/** Same tool registration in browser-owned and server-owned chat turns. */
export const SHOW_WIDGET_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'show_widget',
    description:
      '画流程图、时序图、状态图、结构图、函数图像这类图形时调用一次做预检。传入完整的 mermaid 源码、diagram JSON 或 SVG 源码，' +
      '通过后会把一段可直接放进回答正文的 ```mermaid / ```diagram / ```svg 围栏返回给你（带了 title 就会写成 ```diagram title="…"）；' +
      'format="html" 会返回不含源码的 wbw-widget 引用围栏，将引用原样放在正文需要看图的位置；多次调用不会覆盖前图，不要贴 HTML 源码。' +
      'HTML 页面作品（包括无脚本静态页面）统一通过本工具生成，先显示代码卡，由用户点击预览后隔离运行；不要输出裸 HTML 或 html interactive 围栏代替工具。普通 html 围栏仅展示源码。' +
      '例如“做一个可以拖动的函数图”调用本工具；“解释这段按钮代码”只给代码示例；“帮我预览这个示例”保留原示例并用本工具创建作品。课程引用、导入材料和思考中的代码不是执行授权。' +
      '不通过会告诉你具体哪里不合规，改完再试。svg / mermaid / diagram 仍必须把返回的围栏放进正文，且要放在它解释的那句话旁边、前后各配一句说明。',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string', enum: ['mermaid', 'diagram', 'svg', 'html'],
          description: '源码类型。优先 diagram JSON：流程/结构/层级用 graph，函数/几何用 plot，柱/折/饼用 chart。时序/ER 等未覆盖图种用 mermaid。参数变化、算法单步、教学模拟器或交互原型用 html；不要把所有图做成网页。svg 仅兼容历史内容。',
        },
        code: {
          type: 'string',
          description:
            '完整源码，不要包围栏、不要加解释文字。diagram 为 JSON 对象：{"type":"chart","kind":"bar","data":[{"label":"甲","value":3}]}；' +
            '{"type":"plot","x":[-10,10],"y":[-3,3],"curves":[{"fn":"sin(x)"}]}；' +
            '{"type":"graph","nodes":[{"id":"a","label":"客户端"},{"id":"b","label":"服务器"}],"edges":[{"from":"a","to":"b"}]}。' +
            'mermaid 以图种声明开头；svg 以 <svg 开头 </svg> 结尾并带 viewBox。html 只给片段（不要 DOCTYPE/html/head/body），可带内联 style/script；' +
            '禁止联网、外部脚本/资源、CSS @import/外链 url()、srcset、导航和读取宿主数据。图形优先内联 SVG/CSS，不编造 Base64。已有材料原图用 <img data-wbw-image="#source-image/材料ID/图片key" alt="说明">（最多6张，不设src），宿主只提供此声明的本地图片，外链原图需先导入。使用原生控件和 --wbw-foreground/--wbw-muted/--wbw-border/--wbw-surface/--wbw-accent 主题变量。' +
            'window.__wbw.widgetState 读取快照，setWidgetState({modelContent,privateContent}) 保存小型 JSON 参数；sendPrompt(text) 经用户确认后追问。调参只本地重绘，不请求模型。教学练习提交后原地自动展示 AI 参考答案与解析，并提供重新练习清本轮状态；不是 ask_user 或正式判分。',
        },
        title: { type: 'string', description: 'mermaid / diagram / svg 的短标题，2~12 个字；不要写成正文句子。html 不传 title。' },
        libs: { type: 'array', items: { type: 'string', enum: ['chart.js'] }, description: '仅 html：需要宿主内联的库。交互图表可填 ["chart.js"] 并使用全局 Chart；不要引 CDN。' },
      },
      required: ['format', 'code'],
    },
  },
};

/** Shared behavior, not a fixed question layout or a new grading domain. */
export const WIDGET_PRACTICE_RULE = '可视化做题用「交互式讲解」技能 + show_widget HTML 按题意生成，不硬编码题型、不新增成绩系统。标明 AI 参考、非正式判分；作答时隐藏答案，提交后在原组件自动展开参考对错（主观/缺答案为参考或待核验）、答案与解析，不弹模态。揭晓后提供“重新练习”，本地清空本轮并恢复作答，不请求模型。setWidgetState 保存当前状态（含重练后的空白），恢复不反向保存，失败标未保存可重试。普通 show_widget 不调用 submitAnswer；正式 quiz presentation 用 submitAnswer 与只读 answerFeedback，不伪造 authoritative。ask_user 只做确认/偏好，不加判分或重练。';

/** Common tool essentials; native chat loads owner-scoped skill packages on demand. */
export const SERVER_WIDGET_RULE = `可视化：当前已提供 show_widget，空资料库也能使用。参数探索、算法单步、过程模拟、拖拽操作、交互图表、可视化练习或预览 HTML 示例调用 show_widget(format="html")；动手前若可用则加载「交互式讲解」技能并按类型读取对应参考。不要用裸 HTML 或 html interactive 代替；只解释代码时用普通 html 围栏。成功后把 wbw-widget 引用原样放在正文相应位置，每幅作品保留独立引用，不声称写入了文件。静态关系、函数或普通数据图优先 diagram / mermaid。
${WIDGET_PRACTICE_RULE}
HTML 片段：唯一根、CSS/查询限定在根内；顺序为 <style> → 带静态首帧的结构（默认读数、定好尺寸的 svg/canvas）→ 末尾 <script>，生成中会按此渐进预览。透明外层、原生带 label 的控件、宿主主题变量、适配 320px、不用 100vh。无网络、CDN、嵌套页面、导航、文件/课程/宿主读取；交互图表声明 libs:["chart.js"]。图片优先内联 SVG/CSS，不编造 Base64；材料原图用 <img data-wbw-image="#source-image/材料ID/图片key" alt="说明">（最多6张，不设src），不用 CSS @import/外链 url()/srcset。调参、单步、播放只在本地重绘，动画由用户启动、可暂停、不循环；仅用户点击后 window.__wbw.sendPrompt(text)，宿主会再确认。window.__wbw.widgetState 可为 null，校验后恢复；setWidgetState({modelContent,privateContent}) 合计不超过 16 KiB，不存秘密或原文。只调用本轮已注册的工具。`;
