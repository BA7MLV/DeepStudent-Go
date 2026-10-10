import { Icon } from "../components/Icon";
import { navItems, type ViewId } from "../routes";

export type NavigationProps = {
  view: ViewId;
  settingsOpen: boolean;
  onSelect: (view: ViewId) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
};

export function Navigation({ view, settingsOpen, onSelect, onOpenSettings, onToggleSidebar }: NavigationProps) {
  return <aside className="ds-sidebar" data-shell-layer="navigation" aria-label="DeepStudent 主入口">
    <div className="ds-sidebar__brand">
      <span className="ds-sidebar__brand-name">DeepStudent</span>
      <div className="ds-sidebar__brand-actions">
        <button className="ds-icon-button" type="button" onClick={() => onSelect("learning-hub")} aria-label="搜索资料"><Icon name="search" size={15} /></button>
        <button className="ds-sidebar-toggle" type="button" onClick={onToggleSidebar} aria-label="收起侧边栏"><Icon name="sidebar" size={16} /></button>
      </div>
    </div>
    <nav className="ds-primary-nav" aria-label="主入口">
      {navItems.map((item) => <button key={item.id} className="ds-nav-row" onClick={() => onSelect(item.id)} data-active={item.id === view}><span className="ds-nav-icon"><Icon name={item.icon} size={16} /></span><span>{item.label}</span></button>)}
    </nav>
    <div className="ds-sidebar__scroll">
      <section className="ds-sidebar-section"><div className="ds-section-label"><span>置顶</span><button className="ds-section-action" aria-label="收起置顶"><Icon name="chevron-down" size={14} /></button></div><p className="ds-sidebar-empty">暂无置顶会话</p></section>
      <section className="ds-sidebar-section"><div className="ds-section-label"><span>主题</span><span className="ds-section-tools"><button className="ds-section-action" aria-label="收起主题"><Icon name="chevron-down" size={14} /></button><button className="ds-section-action" aria-label="新建主题"><Icon name="plus" size={14} /></button></span></div><p className="ds-sidebar-empty">暂无主题</p></section>
      <section className="ds-sidebar-section"><div className="ds-section-label"><span>对话</span><button className="ds-section-action" onClick={() => onSelect("chat-v2")} aria-label="新建对话"><Icon name="plus" size={14} /></button></div><p className="ds-sidebar-empty">暂无对话</p></section>
    </div>
    <div className="ds-sidebar__footer">
      <button className="ds-nav-row" onClick={onOpenSettings} data-active={settingsOpen} aria-haspopup="dialog" aria-expanded={settingsOpen}><span className="ds-nav-icon"><Icon name="settings" size={16} /></span><span>设置</span></button>
    </div>
  </aside>;
}
