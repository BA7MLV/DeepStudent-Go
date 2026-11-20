/**
 * 登录/引导页的五个蓝图线稿(compact 版;560×440 全开本源文件在同目录 figures/*.svg)。
 * 采用 Plotter 视觉语法:currentColor 单一墨色、1 单位描边、透明形面,不透明度分级构建
 * 层次(0.14 辅助构造 / 0.32 次要形与尺寸 / 0.38 提案轮廓 / 0.5 位移 / 0.95 主体)。
 * 深浅色随 currentColor 自动跟随;vector-effect 让描边在任意显示尺寸下保持 1px。
 * 每张图只讲一个构造关系,见源 SVG 的 <desc> 与同目录全开本。
 */
import type { ComponentType } from 'react';
import type { FigureName } from './flow';

export function SettleFigure() {
  return <svg viewBox="80 104 328 224" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true" focusable="false">
        <g opacity="0.14" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M108 312.0H452" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M272.0 256.0H288.0 M280.0 248.0V264.0"/><path vectorEffect="non-scaling-stroke" d="M348.0 276.0H364.0 M356.0 268.0V284.0"/><path vectorEffect="non-scaling-stroke" d="M196.0 276.0H212.0 M204.0 268.0V284.0"/></g>
        <g opacity="0.32" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M274.0 312.0H286.0 M350.0 312.0H362.0" strokeDasharray="none"/></g>
        <g opacity="0.38" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M204.00 312.00A36 36 0 0 0 204.00 240.00M204.00 240.00A36 36 0 0 0 204.00 312.00" strokeDasharray="2 2"/></g>
        <g strokeOpacity="0.95"><path vectorEffect="non-scaling-stroke" d="M280.00 312.00A56 56 0 0 0 280.00 200.00M280.00 200.00A56 56 0 0 0 280.00 312.00" strokeDasharray="none"/><path vectorEffect="non-scaling-stroke" d="M356.00 312.00A36 36 0 0 0 356.00 240.00M356.00 240.00A36 36 0 0 0 356.00 312.00" strokeDasharray="none"/><path vectorEffect="non-scaling-stroke" d="M132.00 192.00A36 36 0 0 0 132.00 120.00M132.00 120.00A36 36 0 0 0 132.00 192.00" strokeDasharray="none"/></g>
        <g opacity="0.5" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M151.55 188.58L181.36 238.27" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M182.82 232.45L181.36 238.27L175.54 236.82" strokeDasharray="none" strokeOpacity="1"/></g>
    </svg>;
}

export function VaultFigure() {
  return <svg viewBox="78 160 406 164" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true" focusable="false">
        <rect vectorEffect="non-scaling-stroke" fill="currentColor" x="372.0" y="234.0" width="96.0" height="16.0" stroke="none" fillOpacity="0.055"/>
        <g strokeOpacity="0.95"><path vectorEffect="non-scaling-stroke" d="M132.00 280.00A38 38 0 0 0 132.00 204.00M132.00 204.00A38 38 0 0 0 132.00 280.00"/><path vectorEffect="non-scaling-stroke" d="M132.00 258.00A16 16 0 0 0 132.00 226.00M132.00 226.00A16 16 0 0 0 132.00 258.00"/><path vectorEffect="non-scaling-stroke" d="M169.15 234.0H318.0 M169.15 250.0H318.0"/><path vectorEffect="non-scaling-stroke" d="M262 250.0V274.0H278V250.0"/><path vectorEffect="non-scaling-stroke" d="M288 250.0V274.0H304V250.0"/><path vectorEffect="non-scaling-stroke" d="M372.0 176.0V234.0 M372.0 250.0V308.0 H468.0 V250.0 M468.0 234.0V176.0 H372.0"/><path vectorEffect="non-scaling-stroke" d="M372.0 234.0H364 M372.0 250.0H364"/></g>
        <g opacity="0.5" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M330 242H352" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M347.76 237.76L352.00 242.00L347.76 246.24" strokeDasharray="none" strokeOpacity="1"/></g>
    </svg>;
}

export function PadlockFigure() {
  return <svg viewBox="216 148 128 220" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true" focusable="false">
        <g strokeOpacity="0.95"><path vectorEffect="non-scaling-stroke" d="M252.0 240.0V192.0 A28.0 28.0 0 0 1 308.0 192.0V240.0"/><path vectorEffect="non-scaling-stroke" d="M266.0 240.0V206.0 A14.0 14.0 0 0 1 294.0 206.0V240.0"/><rect vectorEffect="non-scaling-stroke" x="232.0" y="240.0" width="96.0" height="112.0" rx="16"/><path vectorEffect="non-scaling-stroke" d="M271.0 286.0A9.0 9.0 0 1 0 289.0 286.0"/><path vectorEffect="non-scaling-stroke" d="M271.0 286.0A9.0 9.0 0 0 1 289.0 286.0"/><path vectorEffect="non-scaling-stroke" d="M277.0 294.49V316.0H283.0V294.49"/></g>
        <circle vectorEffect="non-scaling-stroke" fill="currentColor" cx="280.0" cy="286.0" r="9.0" stroke="none" fillOpacity="0.055"/>
    </svg>;
}

export function PhoneFigure() {
  return <svg viewBox="124 80 272 266" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true" focusable="false">
        <g opacity="0.14" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M196.0 166.0V246.0 M156.0 206.0H236.0" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M240.0 132.0V184.0 M352.0 132.0V184.0"/></g>
        <g opacity="0.38" strokeOpacity="1"><rect vectorEffect="non-scaling-stroke" x="240.0" y="192.0" width="112.0" height="28.0" rx="8" strokeDasharray="2 2"/></g>
        <rect vectorEffect="non-scaling-stroke" fill="currentColor" x="240.0" y="192.0" width="112.0" height="28.0" rx="8" stroke="none" fillOpacity="0.055"/>
        <g strokeOpacity="0.95"><rect vectorEffect="non-scaling-stroke" x="140.0" y="150.0" width="240.0" height="180.0" rx="16"/><path vectorEffect="non-scaling-stroke" d="M196.00 234.00A28.0 28.0 0 0 0 196.00 178.00M196.00 178.00A28.0 28.0 0 0 0 196.00 234.00"/><rect vectorEffect="non-scaling-stroke" x="240.0" y="96.0" width="112.0" height="28.0" rx="8"/></g>
        <g opacity="0.5" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M296.0 128.0V180.0" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M300.24 175.76L296.00 180.00L291.76 175.76" strokeDasharray="none" strokeOpacity="1"/></g>
    </svg>;
}

export function HubFigure() {
  return <svg viewBox="60 68 436 304" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden="true" focusable="false">
        <g opacity="0.14" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M464.0 56V384" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M72.0 220.0H120.0 M96.0 196.0V244.0"/><path vectorEffect="non-scaling-stroke" d="M264.0 220.0H296.0 M280.0 204.0V236.0"/></g>
        <g opacity="0.38" strokeOpacity="1"><path vectorEffect="non-scaling-stroke" d="M280.0 220.0L448.0 100.0" strokeDasharray="2 2"/><path vectorEffect="non-scaling-stroke" d="M280.0 220.0L448.0 340.0" strokeDasharray="2 2"/></g>
        <circle vectorEffect="non-scaling-stroke" fill="currentColor" cx="464.0" cy="220.0" r="16.0" stroke="none" fillOpacity="0.055"/>
        <g strokeOpacity="0.95"><path vectorEffect="non-scaling-stroke" d="M116.0 220.0H270.0"/><path vectorEffect="non-scaling-stroke" d="M290.0 220.0L438.00 220.00"/><path vectorEffect="non-scaling-stroke" d="M433.76 215.76L438.00 220.00L433.76 224.24"/><path vectorEffect="non-scaling-stroke" d="M96.00 240.00A20.0 20.0 0 0 0 96.00 200.00M96.00 200.00A20.0 20.0 0 0 0 96.00 240.00"/><path vectorEffect="non-scaling-stroke" d="M280.00 230.00A10.0 10.0 0 0 0 280.00 210.00M280.00 210.00A10.0 10.0 0 0 0 280.00 230.00"/></g>
        <g strokeOpacity="0.95"><path vectorEffect="non-scaling-stroke" d="M464.00 116.00A16.0 16.0 0 0 0 464.00 84.00M464.00 84.00A16.0 16.0 0 0 0 464.00 116.00"/><path vectorEffect="non-scaling-stroke" d="M464.00 236.00A16.0 16.0 0 0 0 464.00 204.00M464.00 204.00A16.0 16.0 0 0 0 464.00 236.00"/><path vectorEffect="non-scaling-stroke" d="M464.00 356.00A16.0 16.0 0 0 0 464.00 324.00M464.00 324.00A16.0 16.0 0 0 0 464.00 356.00"/></g>
    </svg>;
}

export const STEP_FIGURES: Record<FigureName, ComponentType> = {
  settle: SettleFigure,
  vault: VaultFigure,
  padlock: PadlockFigure,
  phone: PhoneFigure,
  hub: HubFigure,
};
