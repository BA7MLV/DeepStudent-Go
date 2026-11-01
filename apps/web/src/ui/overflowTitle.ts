/** Measure only on interaction, not on every render or streamed token.
 * Native titles add no wrapper, layout, observers or tooltip animation.
 * Recheck on each entry so resizing, font loading and changed copy are covered.
 */
export function updateOverflowTitle({ currentTarget: element }: { currentTarget: HTMLElement }): void {
  const clipped = element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
  if (clipped) element.title = element.textContent?.trim() ?? '';
  else element.removeAttribute('title');
}

export const overflowTitleProps = {
  onPointerEnter: updateOverflowTitle,
  onFocus: updateOverflowTitle,
};
