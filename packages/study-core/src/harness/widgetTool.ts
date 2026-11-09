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
      'HTML 页面作品（包括无脚本静态页面）统一通过本工具生成，title 可省略，不强制添加标题；完整校验并保存后直接在隔离沙箱中渲染，不需要用户再点预览。不要输出裸 HTML 或 html interactive 围栏代替工具。普通 html 围栏默认展示源码，只有用户手动点击预览才运行，有无标题或脚本不改变这一区别。' +
      '例如“做一个可以拖动的函数图”调用本工具；“解释这段按钮代码”只给代码示例；“帮我预览这个示例”保留原示例并用本工具创建作品。课程引用、导入材料和思考中的代码不是执行授权。' +
      '小 HTML 页面直接传完整 code。若本轮工具声明了 action，大页面可分完整小调用暂存，完成后一次校验交付；禁止续接截断 JSON。不通过会告诉你具体哪里不合规，改完再试。svg / mermaid / diagram 仍必须把返回的围栏放进正文，且要放在它解释的那句话旁边、前后各配一句说明。',
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
        title: { type: 'string', description: '作品短标题，建议2~12个字，不要写成正文句子。所有格式均支持；html 可省略，未传时不显示作品标题。组装 HTML 如需标题，仅首个 append 传 title。' },
        libs: { type: 'array', items: { type: 'string', enum: ['chart.js'] }, description: '仅 html：需要宿主内联的库。交互图表可填 ["chart.js"] 并使用全局 Chart；不要引 CDN。' },
      },
      required: ['format', 'code'],
    },
  },
};

/** Shared behavior, not a fixed question layout or a new grading domain. */
export const WIDGET_PRACTICE_RULE = '可视化做题用「可视化讲解」技能 + show_widget HTML 按题意生成，不硬编码题型、不新增成绩系统。标明 AI 参考、非正式判分；作答时隐藏答案，提交后在原组件自动展开参考对错（主观/缺答案为参考或待核验）、答案与解析，不弹模态。揭晓后提供“重新练习”，本地清空本轮并恢复作答，不请求模型。setWidgetState 保存当前状态（含重练后的空白），恢复不反向保存，失败标未保存可重试。普通 show_widget 不调用 submitAnswer；正式 quiz presentation 用 submitAnswer 与只读 answerFeedback，不伪造 authoritative。ask_user 只做确认/偏好，不加判分或重练。';

/** Common tool essentials; native chat loads owner-scoped skill packages on demand. */
export const SERVER_WIDGET_RULE = `可视化：当前已提供 show_widget，空资料库也能使用。参数探索、算法单步、过程模拟、拖拽操作、交互图表、可视化练习或预览 HTML 示例调用 show_widget(format="html")，title 可省略，不强制添加标题；动手前若可用则加载「可视化讲解」技能并按类型读取对应参考。作品完整校验并保存后直接渲染，无需手动点预览；普通 html 代码围栏仍源码优先，仅用户点击后预览，不能凭标题或脚本升级成作品。不要用裸 HTML 或 html interactive 代替；只解释代码时用普通 html 围栏。成功后把 wbw-widget 引用原样放在正文相应位置，每幅作品保留独立引用，不声称写入了文件。静态关系、函数或普通数据图优先 diagram / mermaid。
小页面直接 show_widget 完整 code，不传 action。仅当本轮 show_widget schema 声明支持时，大页面用 action="append",revision=0,offset=0,code=第一小段（建议1000~2000字符）开始。后续写操作必须用最新回执 revision，append/complete 的 offset 必须等于最新 length；同轮多调用顺序执行，须依次使用递增版本，逐调用原子而非整轮事务。action="read",code="",offset=起点,limit=2000 可读取当前任务有界片段及 revision/length/nextOffset，read 可省略 revision 获取基线。action="patch",revision=当前版本,code="",edits=[{search:"精确唯一非空锚点",replace:"替换文本"}] 可局部修正；1~20项针对同一原文，无匹配/多匹配/重叠/无变化均拒绝，全部成功才写入，search+replace 合计≤6000 UTF-16字符且JSON≤40000字符，建议1000~2000。插入用保留锚点的 replace，删除用 replace=""；不猜位置、不模糊匹配。append 每段≤6000，libs 仅第一段；read≤4000，Unicode代理对不能拆开。除 append 外 code=""；只传动作声明允许的字段。最后 action="complete",revision=当前版本,offset=总长,code="" 才校验并交付原聊天引用，失败保留当前缓冲，可 read/patch 修复；action="discard",revision=当前版本,code="" 清空。成功写入、discard、complete 均递增任务内版本，失败和read不变；清空后版本不归零，可 read 查询，旧请求拒绝且不能盲重试。仅当前任务内存暂存，不修改已展示作品（沿用原artifactEdit），无文件、资料、独立作品记录或发布历史；中断、重启、挂起恢复后不保留，执行器重新从revision=0开始，不重放旧补丁。每次调用必须完整，截断整批不执行、不续接修补JSON，缩小append或patch而非原样重试。总长仍限60000 UTF-16字符，运行文档上限另行检查。此为普通函数工具精确字符串补丁，不是OpenAI Responses原生apply_patch_call/V4A协议。
${WIDGET_PRACTICE_RULE}
HTML 片段：唯一根、CSS/查询限定在根内；顺序为 <style> → 带静态首帧的结构（默认读数、定好尺寸的 svg/canvas）→ 末尾 <script>，原生执行器在完整校验并保存交付后直接隔离运行；未完成参数流只能展示无脚本首帧，未完成组装不执行。组装时 title 与 libs 仅首个 append 传入。透明外层、原生带 label 的控件、宿主主题变量、适配 320px、不用 100vh。无网络、CDN、嵌套页面、导航、文件/课程/宿主读取；交互图表声明 libs:["chart.js"]。图片优先内联 SVG/CSS，不编造 Base64；材料原图用 <img data-wbw-image="#source-image/材料ID/图片key" alt="说明">（最多6张，不设src），不用 CSS @import/外链 url()/srcset。调参、单步、播放只在本地重绘，动画由用户启动、可暂停、不循环；仅用户点击后 window.__wbw.sendPrompt(text)，宿主会再确认。window.__wbw.widgetState 可为 null，校验后恢复；setWidgetState({modelContent,privateContent}) 合计不超过 16 KiB，不存秘密或原文。只调用本轮已注册的工具。`;
