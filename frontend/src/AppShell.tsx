import { useEffect, useMemo, useState } from "react";
import { HealthService } from "./mygo";
import { getRuntimeConfig, updateRuntimeConfig } from "./runtime-api";
import { Icon } from "./components/Icon";
import { Navigation } from "./navigation/Navigation";
import { ChatWorkspace, Flashcards, LearningHub, Settings, Skills, Todo } from "./pages";
import type { ResourceQuestion } from "./ResourceLibrary";
import { SettingsModal } from "./SettingsModal";
import { Onboarding, readOnboardingConfig, onboardingStorageKey, type OnboardingConfig } from "./Onboarding";
import { viewIds, viewTitles, type Theme, type ViewId } from "./routes";
import "./shell.css";

const readTheme = (): Theme => {
  const saved = window.localStorage.getItem("dstu-theme-mode");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export function AppShell() {
  const [view, setView] = useState<ViewId>(() => {
    const requested = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;
    return requested && viewIds.includes(requested as ViewId) ? requested as ViewId : "chat-v2";
  });
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resourcePrompt, setResourcePrompt] = useState<string>();
  const [onboardingConfig, setOnboardingConfig] = useState<OnboardingConfig | null>(() => readOnboardingConfig());
  const [onboardingOpen, setOnboardingOpen] = useState(() => onboardingConfig === null && new URLSearchParams(window.location.search).get("onboarding") !== "skip");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("dstu-theme-mode", theme);
  }, [theme]);
  useEffect(() => { void HealthService.health().catch(() => undefined); }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const completeOnboarding = (config: Omit<OnboardingConfig, "completedAt">) => {
    const saved = { ...config, completedAt: new Date().toISOString() };
    window.localStorage.setItem(onboardingStorageKey, JSON.stringify(saved));
    setOnboardingConfig(saved);
    setOnboardingOpen(false);
    void getRuntimeConfig().then((runtimeConfig) => {
      const preferred = config.model === "local" ? "deterministic" : (runtimeConfig.providers["custom-openai"] ? "custom-openai" : runtimeConfig.default_provider);
      const provider = runtimeConfig.providers[preferred];
      if (!provider) return;
      return updateRuntimeConfig({ provider: preferred, model: provider.model || runtimeConfig.default_model, base_url: provider.base_url });
    }).catch(() => undefined);
  };
  const openOnboarding = () => setOnboardingOpen(true);
  const selectView = (next: ViewId) => {
    setView(next);
    setSidebarOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState({}, "", url);
  };
  const content = useMemo(() => {
    if (view === "chat-v2") return <ChatWorkspace initialPrompt={resourcePrompt} onPromptConsumed={() => setResourcePrompt(undefined)} />;
    if (view === "learning-hub") return <LearningHub onAsk={(question: ResourceQuestion) => { setResourcePrompt(question.prompt); selectView("chat-v2"); }} />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "flashcards") return <Flashcards />;
    return <Settings theme={theme} onTheme={toggleTheme} onOpenOnboarding={openOnboarding} />;
  }, [resourcePrompt, theme, view]);
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen((open) => !open);
    else setSidebarCollapsed((collapsed) => !collapsed);
  };

  return <div className="ds-shell" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed} data-view={view}>
    <div className="ds-body">
      <Navigation view={view} settingsOpen={settingsOpen} onSelect={selectView} onOpenSettings={() => setSettingsOpen(true)} onToggleSidebar={toggleSidebar} />
      <button className="ds-overlay" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"></button>
      <main className="ds-main" data-shell-layer="workspace" data-view={view}>
        <header className="ds-main__header">
          <div className="ds-main__leading">
            <button className="ds-menu-button" type="button" onClick={toggleSidebar} aria-label="切换边栏" aria-expanded={sidebarOpen || !sidebarCollapsed}><Icon name="menu" size={17} /></button>
            <button className="ds-main-logo-button" type="button" onClick={toggleSidebar} aria-label="展开侧边栏" aria-expanded={!sidebarCollapsed}><img src="/logo-black.svg" alt="" /><span className="ds-main-logo-button__affordance" aria-hidden="true"><Icon name="sidebar" size={15} /></span></button>
            <span className="ds-main__brand">DeepStudent</span>
          </div>
          {viewTitles[view] && <h1 className="ds-main__title">{viewTitles[view]}</h1>}
          <div className="ds-main__actions"><button className="ds-icon-button" type="button" onClick={toggleTheme} aria-label="切换主题"><Icon name="sun" size={16} /></button></div>
        </header>
        <div className="ds-main__content">{content}</div>
      </main>
    </div>
    {onboardingOpen && <Onboarding initial={onboardingConfig} onComplete={completeOnboarding} />}
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
  </div>;
}
