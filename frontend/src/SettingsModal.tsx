import { useEffect, useState } from "react";
import { getRuntimeConfig, testRuntimeConfig, updateRuntimeConfig, type RuntimeAgentMode, type RuntimeConfig } from "./runtime-api";
import { Icon } from "./components/Icon";

type ProviderPreview = {
  id: string;
  label: string;
  model: string;
  baseURL: string;
  apiKeyEnv: string;
};

// These profiles mirror the non-secret defaults in internal/config. Credentials
// stay in the Go process environment and are never read, entered, or persisted
// in the browser.
const providerPreviews: ProviderPreview[] = [
  { id: "deterministic", label: "DeepStudent Local（无密钥）", model: "stub", baseURL: "本地 runtime", apiKeyEnv: "不需要" },
  { id: "siliconflow", label: "SiliconFlow", model: "Qwen/Qwen2.5-7B-Instruct", baseURL: "https://api.siliconflow.cn/v1", apiKeyEnv: "SILICONFLOW_API_KEY" },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "custom-openai", label: "自定义 OpenAI 兼容服务", model: "未设置", baseURL: "由 DEEPSTUDENT_CUSTOM_BASE_URL 提供", apiKeyEnv: "DEEPSTUDENT_CUSTOM_API_KEY" },
];

const agentModeOptions: Array<{ value: RuntimeAgentMode; label: string; description: string }> = [
  { value: "auto", label: "自动发现", description: "自动查找本地 Pi CLI；找不到时使用内置 Go Agent" },
  { value: "manual", label: "手动托管 CLI", description: "由 Go runtime 按命令和参数启动 Pi Agent" },
  { value: "external", label: "外部 Pi Agent", description: "连接已由其他进程启动的 Pi sidecar" },
];

const isAgentMode = (value: unknown): value is RuntimeAgentMode => agentModeOptions.some((option) => option.value === value);

const normalizeAgentMode = (value: unknown, fallback: RuntimeAgentMode): RuntimeAgentMode => {
  if (isAgentMode(value)) return value;
  // Accept settings written by older shells while only writing the canonical
  // auto/manual/external values understood by the current runtime.
  if (value === "managed" || value === "local") return "manual";
  if (value === "deterministic") return "auto";
  return fallback;
};

const parseAgentArgs = (value: string): string[] => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);

const formatAgentArgs = (args: string[] | undefined): string => (args ?? []).join("\n");

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [providerId, setProviderId] = useState(providerPreviews[0].id);
  const [model, setModel] = useState(providerPreviews[0].model);
  const [baseURL, setBaseURL] = useState(providerPreviews[0].baseURL);
  const [apiKeyEnv, setAPIKeyEnv] = useState(providerPreviews[0].apiKeyEnv);
  const [agentMode, setAgentMode] = useState<RuntimeAgentMode>("auto");
  const [piEndpoint, setPiEndpoint] = useState("");
  const [piSkipStart, setPiSkipStart] = useState(false);
  const [piCommand, setPiCommand] = useState("");
  const [piArgs, setPiArgs] = useState("");
  const [piCancelTimeout, setPiCancelTimeout] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const applyRuntimeConfig = (config: RuntimeConfig, fallback?: { mode?: RuntimeAgentMode; endpoint?: string; skipStart?: boolean; command?: string; args?: string }) => {
    setRuntimeConfig(config);
    const selected = config.runtime?.default_provider || config.default_provider || Object.keys(config.providers)[0] || providerPreviews[0].id;
    setProviderId(selected);
    setModel(config.runtime?.default_model || config.default_model || config.providers[selected]?.model || "");
    setBaseURL(config.providers[selected]?.base_url || "");
    setAPIKeyEnv(config.providers[selected]?.api_key_env || "");

    const runtime = config.runtime;
    const mode = normalizeAgentMode(runtime?.pi_mode, fallback?.mode ?? (runtime?.pi_endpoint ? "external" : "auto"));
    setAgentMode(mode);
    setPiEndpoint(runtime?.pi_endpoint ?? fallback?.endpoint ?? "");
    setPiSkipStart(runtime?.pi_skip_start ?? fallback?.skipStart ?? false);
    setPiCommand(runtime?.pi_command ?? fallback?.command ?? "");
    setPiArgs(formatAgentArgs(runtime?.pi_args) || fallback?.args || "");
    setPiCancelTimeout(runtime?.pi_cancel_timeout ?? "");
  };

  useEffect(() => {
    let active = true;
    void getRuntimeConfig().then((config) => {
      if (!active) return;
      applyRuntimeConfig(config);
    }).catch((error) => {
      if (active) setStatus(error instanceof Error ? error.message : "无法读取 Go runtime 配置");
    });
    return () => { active = false; };
  }, []);

  const saveConfig = async () => {
    setStatus("正在保存…");
    try {
      const savedAgent = {
        mode: agentMode,
        endpoint: agentMode === "auto" ? "" : piEndpoint.trim(),
        skipStart: agentMode === "external" ? piSkipStart : false,
        command: agentMode === "manual" ? piCommand.trim() : "",
        args: agentMode === "manual" ? piArgs : "",
      };
      const config = await updateRuntimeConfig({
        provider: providerId,
        model,
        base_url: baseURL,
        pi_mode: savedAgent.mode,
        pi_endpoint: savedAgent.endpoint,
        pi_skip_start: savedAgent.skipStart,
        pi_command: savedAgent.command,
        pi_args: parseAgentArgs(savedAgent.args),
        pi_cancel_timeout: piCancelTimeout.trim(),
      });
      applyRuntimeConfig(config, savedAgent);
      setStatus("已保存，下一条消息将使用此模型。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败");
    }
  };

  const checkConfig = async () => {
    setStatus("正在测试连接…");
    try {
      await testRuntimeConfig({ provider: providerId, model, base_url: baseURL });
      setStatus("连接成功，可以保存配置。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "连接失败");
    }
  };

  return <div className="ds-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ds-settings-modal-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ds-settings-modal__card">
      <header className="ds-settings-modal__header">
        <div>
          <p className="ds-settings-modal__eyebrow">DeepStudent</p>
          <h1 id="ds-settings-modal-title">设置</h1>
          <p className="ds-settings-modal__subtitle">模型服务商与运行环境</p>
        </div>
        <button className="ds-icon-button" type="button" onClick={onClose} aria-label="关闭设置"><Icon name="x" size={18} /></button>
      </header>
      <main className="ds-settings-modal__body">
        <div className="ds-settings-empty-state" role="status">
          <span className="ds-settings-empty-state__icon"><Icon name="settings" size={20} /></span>
          <div>
            <b>{runtimeConfig ? "Go runtime 配置已连接" : "正在读取服务商配置"}</b>
            <p>{runtimeConfig ? "修改配置后可保存，下一条消息将立即使用新模型；密钥仍由 Go 进程环境变量管理。" : "请确认本地 Go runtime 已启动；密钥不会进入页面，也不会写入浏览器存储。"}</p>
          </div>
        </div>
        <section className="ds-settings-provider" aria-labelledby="ds-provider-heading">
          <div className="ds-settings-provider__heading">
            <div><h2 id="ds-provider-heading">模型配置</h2><p>编辑服务商配置并保存；保存时会检查 Go runtime 连接状态。</p></div>
          </div>
          <label className="ds-settings-field">
            <span>服务商 <small>provider</small></span>
            <select value={providerId} onChange={(event) => { const id = event.target.value; const selected = runtimeConfig?.providers[id]; setProviderId(id); if (selected) { setModel(selected.model || ""); setBaseURL(selected.base_url || ""); setAPIKeyEnv(selected.api_key_env || ""); } }} aria-label="服务商 provider">
              {(runtimeConfig ? Object.entries(runtimeConfig.providers).map(([id, item]) => ({ id, label: item.name || id })) : providerPreviews).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="ds-settings-field">
            <span>模型 <small>model</small></span>
            <input value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型 model" />
          </label>
          <label className="ds-settings-field">
            <span>服务地址 <small>baseURL / base_url</small></span>
            <input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} aria-label="服务地址" />
          </label>
          <label className="ds-settings-field">
            <span>密钥变量 <small>api_key_env（只读）</small></span>
            <input value={apiKeyEnv} readOnly aria-label="密钥变量" />
          </label>
        </section>
        <section className="ds-settings-provider" aria-labelledby="ds-agent-heading">
          <div className="ds-settings-provider__heading">
            <div><h2 id="ds-agent-heading">Agent 运行模式</h2><p>选择消息由哪个 Agent 处理；CLI 参数每行填写一个参数。</p></div>
          </div>
          <label className="ds-settings-field">
            <span>运行模式 <small>pi_mode</small></span>
            <select value={agentMode} onChange={(event) => setAgentMode(event.target.value as RuntimeAgentMode)} aria-label="Agent 运行模式">
              {agentModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          {agentMode !== "auto" && <label className="ds-settings-field">
            <span>Agent 地址 <small>pi_endpoint</small></span>
            <input value={piEndpoint} onChange={(event) => setPiEndpoint(event.target.value)} placeholder="http://127.0.0.1:8787" aria-label="Agent 地址" />
          </label>}
          {agentMode === "external" && <label className="ds-settings-field ds-settings-field--checkbox">
            <span>跳过启动 <small>pi_skip_start</small></span>
            <input type="checkbox" checked={piSkipStart} onChange={(event) => setPiSkipStart(event.target.checked)} aria-label="跳过 Pi Agent 启动" />
          </label>}
          {agentMode === "manual" && <>
            <label className="ds-settings-field">
              <span>CLI 命令 <small>pi_command</small></span>
              <input value={piCommand} onChange={(event) => setPiCommand(event.target.value)} placeholder="pi" aria-label="Pi CLI 命令" />
            </label>
            <label className="ds-settings-field ds-settings-field--textarea">
              <span>CLI 参数 <small>pi_args · 每行一个</small></span>
              <textarea value={piArgs} onChange={(event) => setPiArgs(event.target.value)} rows={4} placeholder="--port\n8787" aria-label="Pi CLI 参数" />
            </label>
          </>}
          <label className="ds-settings-field">
            <span>取消超时 <small>pi_cancel_timeout</small></span>
            <input value={piCancelTimeout} onChange={(event) => setPiCancelTimeout(event.target.value)} placeholder="例如 5s" aria-label="Pi Agent 取消超时" />
          </label>
        </section>
      </main>
      <footer className="ds-settings-modal__footer">
        <p>{status || "配置会保存到本机；API key 不会进入页面或保存，api_key_env 仅用于显示。先测试连接，再保存模型设置。"}</p>
        <button type="button" className="ds-secondary-button" onClick={() => void checkConfig()} disabled={!runtimeConfig || status === "正在测试连接…"}>测试连接</button>
        <button type="button" className="ds-primary-button" onClick={() => void saveConfig()} disabled={!runtimeConfig || status === "正在保存…"}>{status === "正在保存…" ? "保存中…" : "保存配置"}</button>
        <button type="button" className="ds-secondary-button" onClick={onClose}>完成</button>
      </footer>
    </section>
  </div>;
}
