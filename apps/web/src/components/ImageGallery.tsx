import type { ReactNode } from 'react';
import { Sym } from '../ui';
import './chat-attachments.css';

/** Only the cover is interactive; up to two decorative cards show the next images. */
export default function ImageGallery({ count, children, cards = [] }: { count: number; children: ReactNode; cards?: ReactNode[] }) {
  return <div className={`chat-image-gallery${count > 1 ? ' chat-image-stack' : ''}`} data-count={count} data-cards={count > 1 && cards.length ? true : undefined}>
    {count > 1 && cards.slice(0, 2).map((card, index) => <div className="chat-image-stack__card" data-depth={index + 1} key={index} aria-hidden="true">{card}</div>)}
    {children}
    {count > 1 && <span className="chat-image-stack__count" aria-hidden="true"><Sym name="image" />{count}</span>}
  </div>;
}
