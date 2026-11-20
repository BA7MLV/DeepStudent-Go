/**
 * B 站导入用到的纯计算模块，独立成一个文件是有原因的。
 *
 * 这些符号都来自只做类型声明的 re-export 文件（`bilibili/pages.ts`、`bilibili/subtitle.ts`
 * 等，内容只有一行 `export * from '@wangke/study-core/…'`），TypeScript 会把它们当作类型使用
 * 并且只生成**类型导入**。只要它们与下载/解析逻辑（`resolveBiliTarget`、`importBiliPages`）
 * 从**同一个模块**导入，打包器就会把那个模块整个算进调用方的静态图 —— 哪怕调用方只是想取
 * 一个默认勾选的空数组，也会先把解析器、字幕抓取一起拉进来。
 *
 * 所以这里只放「不需要网络、不需要解析器」的那几个函数与常量类型，B 站弹窗按需加载时
 * 再和别的模块合到一起。
 */
import type { BiliVideoSource } from '../bilibili/source';
import type { SubtitleBundle } from '../bilibili/subtitle';
import type { BiliTarget } from '../bilibili';

export { formatTotalDuration, pageLabel, resolveSelectedPages, selectedDuration } from '../bilibili/pages';
export { defaultSelectedLangs } from '../bilibili/subtitle';
export type { BiliTarget, BiliVideoSource, SubtitleBundle };

/** 解析链接时取用户输入的文本；普通文本不拦，交给系统默认粘贴行为。 */
export { extractBiliInput } from '../bilibili/parse';

/** 字幕语言条目：与 `BiliTarget.subtitles` 的元素同构，但不必导入 dmview 的实现 */
export type BiliLangItem = BiliTarget['subtitles'][number];
