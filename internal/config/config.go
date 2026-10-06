// Package config owns the server's non-secret configuration model and load order.
package config

import (
    "encoding/json"
    "errors"
    "fmt"
    "net/url"
    "os"
    "regexp"
    "strconv"
    "strings"
    "sync"
    "time"
)

const DefaultVersion = "v1"

const (
    InputText = "text"
    InputImage = "image"
    InputAudio = "audio"
    InputVideo = "video"
    InputFile = "file"
)

type Config struct {
    Version string `json:"version"`
    Server ServerConfig `json:"server"`
    Storage StorageConfig `json:"storage"`
    Runtime RuntimeConfig `json:"runtime"`
    Auth AuthConfig `json:"auth"`
    Providers map[string]ProviderProfile `json:"providers"`
    Models map[string]ModelProfile `json:"models,omitempty"`
}

type ServerConfig struct {
	Addr string `json:"addr"`
	ReadTimeout time.Duration `json:"readTimeout"`
	WriteTimeout time.Duration `json:"writeTimeout"`
	IdleTimeout time.Duration `json:"idleTimeout"`
	// SSEHeartbeat is the interval for an SSE comment heartbeat. It must stay
	// below proxy idle timeouts while remaining independent from run timeout.
	SSEHeartbeat time.Duration `json:"sseHeartbeat"`
	CORSAllowlist []string `json:"corsAllowlist"`
}

type StorageConfig struct {
    SQLitePath string `json:"sqlitePath"`
    BlobRoot string `json:"blobRoot"`
    AttachmentMaxBytes int64 `json:"attachmentMaxBytes"`
    AttachmentAllowedMIMEs []string `json:"attachmentAllowedMIMEs,omitempty"`
}

type RuntimeConfig struct {
    DefaultProvider string `json:"defaultProvider"`
    DefaultModel string `json:"defaultModel,omitempty"`
    DefaultReasoningEffort string `json:"defaultReasoningEffort,omitempty"`
    DefaultTimeout time.Duration `json:"defaultTimeout"`
    MaxTokens int `json:"maxTokens"`
    MaxConcurrency int `json:"maxConcurrency"`
}

type AuthConfig struct {
    Enabled bool `json:"enabled"`
    CookieName string `json:"cookieName"`
    CookieSecure bool `json:"cookieSecure"`
    SessionTTL time.Duration `json:"sessionTTL"`
}

// ProviderProfile contains metadata only. API keys remain environment references.
type ProviderProfile struct {
    Name string `json:"name"`
    BaseURL string `json:"baseURL"`
    BaseURLEnv string `json:"baseURLEnv,omitempty"`
    Model string `json:"model"`
    ReasoningEffort string `json:"reasoningEffort,omitempty"`
    MaxTokens int `json:"maxTokens,omitempty"`
    InputCapabilities []string `json:"inputCapabilities,omitempty"`
    Input []string `json:"input,omitempty"`
    APIKeyEnv string `json:"apiKeyEnv"`
    Timeout time.Duration `json:"timeout"`
    MaxRetries int `json:"maxRetries,omitempty"`
    RetryBackoff time.Duration `json:"retryBackoff,omitempty"`
    Streaming bool `json:"streaming"`
    Models map[string]ModelProfile `json:"models,omitempty"`
}

// ModelProfile is the provider-neutral model route contract.
type ModelProfile struct {
    ID string `json:"id,omitempty"`
    Provider string `json:"provider,omitempty"`
    Model string `json:"model,omitempty"`
    ReasoningEffort string `json:"reasoning_effort,omitempty"`
    MaxTokens int `json:"max_tokens,omitempty"`
    InputCapabilities []string `json:"input_capabilities,omitempty"`
    Input []string `json:"input,omitempty"`
    BaseURL string `json:"base_url,omitempty"`
    BaseURLEnv string `json:"base_url_env,omitempty"`
    Timeout time.Duration `json:"timeout,omitempty"`
    MaxRetries int `json:"max_retries,omitempty"`
    RetryBackoff time.Duration `json:"retry_backoff,omitempty"`
    Streaming *bool `json:"streaming,omitempty"`
}

type ModelSelection struct {
    ProfileID string
    Provider string
    Model string
    ReasoningEffort string
    MaxTokens int
    InputCapabilities []string
    BaseURL string
    APIKeyEnv string
    Timeout time.Duration
    MaxRetries int
    RetryBackoff time.Duration
    Streaming bool
}

func Defaults() Config {
    return Config{
        Version: DefaultVersion,
		// The MyGo embedded WebView uses mygo://localhost as its origin. Keep it
		// on the local allowlist so the desktop React shell can reach the loopback
		// API server when it sends runs and subscribes to SSE events.
		Server: ServerConfig{Addr: "127.0.0.1:8080", ReadTimeout: 15*time.Second, WriteTimeout: 0, IdleTimeout: 60*time.Second, SSEHeartbeat: 15*time.Second, CORSAllowlist: []string{"http://127.0.0.1:5173", "http://localhost:5173", "mygo://localhost"}},
        Storage: StorageConfig{SQLitePath: "data/deepstudent.db", BlobRoot: "data/blobs", AttachmentMaxBytes: 32 << 20, AttachmentAllowedMIMEs: []string{"text/*", "application/json", "application/pdf", "application/octet-stream", "image/*", "audio/*", "video/*"}},
        Runtime: RuntimeConfig{DefaultProvider: "deterministic", DefaultTimeout: 45*time.Second, MaxTokens: 2048, MaxConcurrency: 2},
        Auth: AuthConfig{CookieName: "deepstudent_session", SessionTTL: 24*time.Hour},
        Providers: map[string]ProviderProfile{
            "deterministic": {Name: "deterministic", Model: "stub", Timeout: 45*time.Second, InputCapabilities: []string{InputText}, Streaming: true},
            "siliconflow": {Name: "siliconflow", BaseURL: "https://api.siliconflow.cn/v1", APIKeyEnv: "SILICONFLOW_API_KEY", Model: "Qwen/Qwen2.5-7B-Instruct", Timeout: 45*time.Second, MaxRetries: 2, RetryBackoff: 250*time.Millisecond, Streaming: true, InputCapabilities: []string{InputText}},
            "deepseek": {Name: "deepseek", BaseURL: "https://api.deepseek.com/v1", APIKeyEnv: "DEEPSEEK_API_KEY", Model: "deepseek-chat", Timeout: 45*time.Second, MaxRetries: 2, RetryBackoff: 250*time.Millisecond, Streaming: true, InputCapabilities: []string{InputText}},
            "custom-openai": {Name: "custom-openai", BaseURLEnv: "DEEPSTUDENT_CUSTOM_BASE_URL", APIKeyEnv: "DEEPSTUDENT_CUSTOM_API_KEY", Model: "", Timeout: 45*time.Second, MaxRetries: 2, RetryBackoff: 250*time.Millisecond, Streaming: true, InputCapabilities: []string{InputText}},
        },
    }
}

type lookupEnv func(string) (string, bool)

func Load(path string) (Config, error) { return load(path, os.LookupEnv) }

func load(path string, lookup lookupEnv) (Config, error) {
    cfg := Defaults()
    if path == "" { path, _ = lookup("DEEPSTUDENT_CONFIG") }
    if path != "" {
        data, err := os.ReadFile(path)
        if err != nil { if errors.Is(err, os.ErrNotExist) { return cfg, fmt.Errorf("config file %q: %w", path, err) }; return cfg, err }
        if err := mergeJSON(&cfg, data); err != nil { return cfg, fmt.Errorf("parse config file %q: %w", path, err) }
    }
    if err := applyEnv(&cfg, lookup); err != nil { return cfg, err }
    return cfg, ValidateWithEnv(cfg, lookup)
}

func mergeJSON(cfg *Config, data []byte) error {
    var root map[string]json.RawMessage
    if err := json.Unmarshal(data, &root); err != nil { return err }
    if raw, ok := root["version"]; ok { if err := json.Unmarshal(raw, &cfg.Version); err != nil { return err } }
    if raw, ok := root["server"]; ok { if err := json.Unmarshal(raw, &cfg.Server); err != nil { return err } }
    if raw, ok := root["storage"]; ok { if err := json.Unmarshal(raw, &cfg.Storage); err != nil { return err } }
    if raw, ok := root["runtime"]; ok { if err := json.Unmarshal(raw, &cfg.Runtime); err != nil { return err } }
    if raw, ok := root["auth"]; ok { if err := json.Unmarshal(raw, &cfg.Auth); err != nil { return err } }
    if raw, ok := root["providers"]; ok {
        var providers map[string]json.RawMessage
        if err := json.Unmarshal(raw, &providers); err != nil { return err }
        if providers == nil { cfg.Providers = nil } else {
            if cfg.Providers == nil { cfg.Providers = map[string]ProviderProfile{} }
            for name, item := range providers { p := cfg.Providers[name]; if err := json.Unmarshal(item, &p); err != nil { return err }; if p.Name == "" { p.Name = name }; cfg.Providers[name] = p }
        }
    }
    if raw, ok := root["models"]; ok {
        var models map[string]json.RawMessage
        if err := json.Unmarshal(raw, &models); err != nil { return err }
        if models == nil { cfg.Models = nil } else {
            if cfg.Models == nil { cfg.Models = map[string]ModelProfile{} }
            for id, item := range models { m := cfg.Models[id]; if err := json.Unmarshal(item, &m); err != nil { return err }; if m.ID == "" { m.ID = id }; cfg.Models[id] = m }
        }
    }
    return nil
}

// Accept both the original camelCase provider keys and snake_case aliases.
func (p *ProviderProfile) UnmarshalJSON(data []byte) error {
    type alias ProviderProfile
    aux := struct { *alias; BaseURLSnake *string `json:"base_url"`; BaseURLEnvSnake *string `json:"base_url_env"`; APIKeyEnvSnake *string `json:"api_key_env"`; ReasoningSnake *string `json:"reasoning_effort"`; MaxTokensSnake *int `json:"max_tokens"`; MaxRetriesSnake *int `json:"max_retries"`; RetryBackoffSnake *time.Duration `json:"retry_backoff"`; InputCapsSnake *[]string `json:"input_capabilities"` }{alias: (*alias)(p)}
    if err := json.Unmarshal(data, &aux); err != nil { return err }
    if aux.BaseURLSnake != nil { p.BaseURL = *aux.BaseURLSnake }
    if aux.BaseURLEnvSnake != nil { p.BaseURLEnv = *aux.BaseURLEnvSnake }
    if aux.APIKeyEnvSnake != nil { p.APIKeyEnv = *aux.APIKeyEnvSnake }
    if aux.ReasoningSnake != nil { p.ReasoningEffort = *aux.ReasoningSnake }
    if aux.MaxTokensSnake != nil { p.MaxTokens = *aux.MaxTokensSnake }
    if aux.MaxRetriesSnake != nil { p.MaxRetries = *aux.MaxRetriesSnake }
    if aux.RetryBackoffSnake != nil { p.RetryBackoff = *aux.RetryBackoffSnake }
    if aux.InputCapsSnake != nil { p.InputCapabilities = append([]string(nil), (*aux.InputCapsSnake)...); p.Input = append([]string(nil), (*aux.InputCapsSnake)...) }
    return nil
}

func (m *ModelProfile) UnmarshalJSON(data []byte) error {
    type alias ModelProfile
    aux := struct { *alias; ReasoningCamel *string `json:"reasoningEffort"`; MaxTokensCamel *int `json:"maxTokens"`; InputCamel *[]string `json:"input"`; InputCapsCamel *[]string `json:"inputCapabilities"`; BaseURLCamel *string `json:"baseURL"`; BaseURLEnvCamel *string `json:"baseURLEnv"` }{alias: (*alias)(m)}
    if err := json.Unmarshal(data, &aux); err != nil { return err }
    if aux.ReasoningCamel != nil { m.ReasoningEffort = *aux.ReasoningCamel }
    if aux.MaxTokensCamel != nil { m.MaxTokens = *aux.MaxTokensCamel }
    if aux.InputCapsCamel != nil { m.InputCapabilities = append([]string(nil), (*aux.InputCapsCamel)...); m.Input = append([]string(nil), (*aux.InputCapsCamel)...) } else if aux.InputCamel != nil { m.Input = append([]string(nil), (*aux.InputCamel)...); m.InputCapabilities = append([]string(nil), (*aux.InputCamel)...) }
    if aux.BaseURLCamel != nil { m.BaseURL = *aux.BaseURLCamel }
    if aux.BaseURLEnvCamel != nil { m.BaseURLEnv = *aux.BaseURLEnvCamel }
    return nil
}

func applyEnv(cfg *Config, lookup lookupEnv) error {
    if v, ok := lookup("DEEPSTUDENT_HTTP_ADDR"); ok { cfg.Server.Addr = v }
    if v, ok := lookup("DEEPSTUDENT_DB_PATH"); ok { cfg.Storage.SQLitePath = v }
    if v, ok := lookup("DEEPSTUDENT_BLOB_ROOT"); ok { cfg.Storage.BlobRoot = v }
    if v, ok := lookup("DEEPSTUDENT_ATTACHMENT_MAX_BYTES"); ok { n, err := strconv.ParseInt(v, 10, 64); if err != nil { return fmt.Errorf("DEEPSTUDENT_ATTACHMENT_MAX_BYTES: %w", err) }; cfg.Storage.AttachmentMaxBytes = n }
    if v, ok := lookup("DEEPSTUDENT_ATTACHMENT_ALLOWED_MIME"); ok { cfg.Storage.AttachmentAllowedMIMEs = splitList(v) }
    if v, ok := lookup("DEEPSTUDENT_CORS_ALLOWLIST"); ok { cfg.Server.CORSAllowlist = splitList(v) }
    if v, ok := lookup("DEEPSTUDENT_DEFAULT_PROVIDER"); ok { cfg.Runtime.DefaultProvider = v }
    if v, ok := lookup("DEEPSTUDENT_DEFAULT_MODEL"); ok { cfg.Runtime.DefaultModel = v }
    if v, ok := lookup("DEEPSTUDENT_DEFAULT_REASONING_EFFORT"); ok { cfg.Runtime.DefaultReasoningEffort = v }
    if v, ok := lookup("DEEPSTUDENT_DEFAULT_TIMEOUT"); ok { d, err := time.ParseDuration(v); if err != nil { return fmt.Errorf("DEEPSTUDENT_DEFAULT_TIMEOUT: %w", err) }; cfg.Runtime.DefaultTimeout = d }
    if v, ok := lookup("DEEPSTUDENT_MAX_TOKENS"); ok { n, err := strconv.Atoi(v); if err != nil { return fmt.Errorf("DEEPSTUDENT_MAX_TOKENS: %w", err) }; cfg.Runtime.MaxTokens = n }
    if v, ok := lookup("DEEPSTUDENT_MAX_CONCURRENCY"); ok { n, err := strconv.Atoi(v); if err != nil { return fmt.Errorf("DEEPSTUDENT_MAX_CONCURRENCY: %w", err) }; cfg.Runtime.MaxConcurrency = n }
    if v, ok := lookup("DEEPSTUDENT_AUTH_ENABLED"); ok { b, err := strconv.ParseBool(v); if err != nil { return fmt.Errorf("DEEPSTUDENT_AUTH_ENABLED: %w", err) }; cfg.Auth.Enabled = b }
    if v, ok := lookup("DEEPSTUDENT_COOKIE_SECURE"); ok { b, err := strconv.ParseBool(v); if err != nil { return fmt.Errorf("DEEPSTUDENT_COOKIE_SECURE: %w", err) }; cfg.Auth.CookieSecure = b }
	if v, ok := lookup("DEEPSTUDENT_BASE_URL"); ok { if cfg.Providers == nil { cfg.Providers = map[string]ProviderProfile{} }; p := cfg.Providers[cfg.Runtime.DefaultProvider]; p.BaseURL = strings.TrimSpace(v); if p.Name == "" { p.Name = cfg.Runtime.DefaultProvider }; cfg.Providers[cfg.Runtime.DefaultProvider] = p }
	if v, ok := lookup("DEEPSEEK_BASE_URL"); ok {
		providerName := "deepseek-official"
		if p, exists := cfg.Providers[providerName]; exists { p.BaseURL = strings.TrimSpace(v); cfg.Providers[providerName] = p }
	}
    for name, p := range cfg.Providers {
        prefix := "DEEPSTUDENT_PROVIDER_" + envKey(name) + "_"
        if v, ok := lookup(prefix+"BASE_URL"); ok { p.BaseURL = strings.TrimSpace(v) }
        if v, ok := lookup(prefix+"BASE_URL_ENV"); ok { p.BaseURLEnv = strings.TrimSpace(v) }
        if v, ok := lookup(prefix+"MODEL"); ok { p.Model = strings.TrimSpace(v) }
        if v, ok := lookup(prefix+"REASONING_EFFORT"); ok { p.ReasoningEffort = strings.TrimSpace(v) }
        if v, ok := lookup(prefix+"API_KEY_ENV"); ok { p.APIKeyEnv = strings.TrimSpace(v) }
        if v, ok := lookup(prefix+"MAX_TOKENS"); ok { n, err := strconv.Atoi(v); if err != nil { return fmt.Errorf("%sMAX_TOKENS: %w", prefix, err) }; p.MaxTokens = n }
        if v, ok := lookup(prefix+"MAX_RETRIES"); ok { n, err := strconv.Atoi(v); if err != nil { return fmt.Errorf("%sMAX_RETRIES: %w", prefix, err) }; p.MaxRetries = n }
        if v, ok := lookup(prefix+"RETRY_BACKOFF"); ok { d, err := time.ParseDuration(v); if err != nil { return fmt.Errorf("%sRETRY_BACKOFF: %w", prefix, err) }; p.RetryBackoff = d }
        if v, ok := lookup(prefix+"STREAMING"); ok { b, err := strconv.ParseBool(v); if err != nil { return fmt.Errorf("%sSTREAMING: %w", prefix, err) }; p.Streaming = b }
        if v, ok := lookup(prefix+"INPUT_CAPABILITIES"); ok { p.InputCapabilities = splitList(v) }
        cfg.Providers[name] = p
    }
    return nil
}

func envKey(value string) string { var b strings.Builder; for _, r := range strings.ToUpper(strings.TrimSpace(value)) { if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') { b.WriteRune(r) } else { b.WriteByte('_') } }; return b.String() }
func splitList(value string) []string { var result []string; for _, part := range strings.Split(value, ",") { if part = strings.TrimSpace(part); part != "" { result = append(result, part) } }; return result }

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var validInputs = map[string]struct{}{InputText: {}, InputImage: {}, InputAudio: {}, InputVideo: {}, InputFile: {}}

func Validate(cfg Config) error {
    if cfg.Version == "" { return errors.New("version must not be empty") }
    if strings.TrimSpace(cfg.Server.Addr) == "" { return errors.New("server addr must not be empty") }
    if cfg.Server.ReadTimeout < 0 || cfg.Server.WriteTimeout < 0 || cfg.Server.IdleTimeout < 0 || cfg.Server.SSEHeartbeat < 0 { return errors.New("server timeouts must not be negative") }
    if cfg.Storage.SQLitePath == "" { return errors.New("storage sqlitePath must not be empty") }
    if strings.TrimSpace(cfg.Storage.BlobRoot) == "" { return errors.New("storage blobRoot must not be empty") }
    if cfg.Storage.AttachmentMaxBytes < 0 { return errors.New("storage attachmentMaxBytes must not be negative") }
    if cfg.Runtime.DefaultTimeout <= 0 { return errors.New("runtime defaultTimeout must be positive") }
    if cfg.Runtime.MaxTokens <= 0 { return errors.New("runtime maxTokens must be positive") }
    if cfg.Runtime.MaxConcurrency <= 0 { return errors.New("runtime maxConcurrency must be positive") }
    if cfg.Auth.SessionTTL <= 0 { return errors.New("auth sessionTTL must be positive") }
    if strings.TrimSpace(cfg.Runtime.DefaultProvider) == "" { return errors.New("runtime defaultProvider must not be empty") }
    if _, ok := cfg.Providers[cfg.Runtime.DefaultProvider]; !ok { return fmt.Errorf("runtime defaultProvider %q is not configured", cfg.Runtime.DefaultProvider) }
    if err := validateEffort(cfg.Runtime.DefaultReasoningEffort, "runtime defaultReasoningEffort"); err != nil { return err }
    for name, p := range cfg.Providers { if err := validateProvider(name, p); err != nil { return err } }
    for id, m := range cfg.Models { if err := validateModel(id, m); err != nil { return err }; if m.Provider != "" { if _, ok := cfg.Providers[m.Provider]; !ok { return fmt.Errorf("model %q references unknown provider %q", id, m.Provider) } } }
    return nil
}

func ValidateWithEnv(cfg Config, lookup func(string) (string, bool)) error {
	if err := Validate(cfg); err != nil { return err }
	for name, p := range cfg.Providers {
		endpoint := p.BaseURL
		if p.BaseURLEnv != "" && lookup != nil { if v, ok := lookup(p.BaseURLEnv); ok && strings.TrimSpace(v) != "" { endpoint = strings.TrimSpace(v) } }
		if err := validateURL(endpoint, "provider "+name+" baseURL"); err != nil { return err }
		for id, m := range p.Models { if m.BaseURLEnv != "" && lookup != nil { if v, ok := lookup(m.BaseURLEnv); ok && strings.TrimSpace(v) != "" { if err := validateURL(v, "model "+id+" base_url"); err != nil { return err } } } }
	}
	for id, m := range cfg.Models { if m.BaseURLEnv != "" && lookup != nil { if v, ok := lookup(m.BaseURLEnv); ok && strings.TrimSpace(v) != "" { if err := validateURL(v, "model "+id+" base_url"); err != nil { return err } } } }
	return nil
}

func validateProvider(name string, p ProviderProfile) error {
    if strings.TrimSpace(name) != name || name == "" { return fmt.Errorf("provider name %q is invalid", name) }
    if p.Name != "" && p.Name != name { return fmt.Errorf("provider %q name must match map key", name) }
    if err := validateURL(p.BaseURL, "provider "+name+" baseURL"); err != nil { return err }
    if !envNamePattern.MatchString(p.APIKeyEnv) && p.APIKeyEnv != "" { return fmt.Errorf("provider %q apiKeyEnv is invalid", name) }
    if !envNamePattern.MatchString(p.BaseURLEnv) && p.BaseURLEnv != "" { return fmt.Errorf("provider %q baseURLEnv is invalid", name) }
    if p.Timeout < 0 || p.MaxTokens < 0 || p.MaxRetries < 0 || p.RetryBackoff < 0 { return fmt.Errorf("provider %q limits must not be negative", name) }
    if err := validateEffort(p.ReasoningEffort, "provider "+name+" reasoningEffort"); err != nil { return err }
    caps := p.InputCapabilities; if caps == nil { caps = p.Input }; if err := validateCapabilities(caps, "provider "+name+" inputCapabilities"); err != nil { return err }
    for id, m := range p.Models { if err := validateModel(id, m); err != nil { return err }; if m.Provider != "" && m.Provider != name { return fmt.Errorf("provider %q model %q references provider %q", name, id, m.Provider) } }
    return nil
}

func validateModel(id string, m ModelProfile) error {
    if strings.TrimSpace(id) != id || id == "" { return fmt.Errorf("model id %q is invalid", id) }
    if m.ID != "" && m.ID != id { return fmt.Errorf("model %q id must match map key", id) }
    if m.MaxTokens < 0 || m.Timeout < 0 || m.MaxRetries < 0 || m.RetryBackoff < 0 { return fmt.Errorf("model %q limits must not be negative", id) }
    if err := validateEffort(m.ReasoningEffort, "model "+id+" reasoning_effort"); err != nil { return err }
    caps := m.InputCapabilities; if caps == nil { caps = m.Input }; if err := validateCapabilities(caps, "model "+id+" input_capabilities"); err != nil { return err }
    if err := validateURL(m.BaseURL, "model "+id+" base_url"); err != nil { return err }
	if m.BaseURLEnv != "" && !envNamePattern.MatchString(m.BaseURLEnv) { return fmt.Errorf("model %q base_url_env is invalid", id) }
    return nil
}
func validateCapabilities(values []string, field string) error { seen := map[string]struct{}{}; for _, value := range values { value = strings.ToLower(strings.TrimSpace(value)); if value == "" { return fmt.Errorf("%s contains empty capability", field) }; if _, ok := validInputs[value]; !ok { return fmt.Errorf("%s contains unsupported capability %q", field, value) }; if _, ok := seen[value]; ok { return fmt.Errorf("%s contains duplicate capability %q", field, value) }; seen[value] = struct{}{} }; return nil }
func validateEffort(value, field string) error { if value != strings.TrimSpace(value) || strings.ContainsAny(value, "\r\n") { if value != "" { return fmt.Errorf("%s is invalid", field) } }; return nil }
func validateURL(value, field string) error { if strings.TrimSpace(value) == "" { return nil }; parsed, err := url.Parse(value); if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") { return fmt.Errorf("%s must be an absolute http(s) URL", field) }; return nil }

func (p ProviderProfile) EffectiveBaseURL(lookup lookupEnv) string { if lookup != nil && p.BaseURLEnv != "" { if v, ok := lookup(p.BaseURLEnv); ok && strings.TrimSpace(v) != "" { return strings.TrimSpace(v) } }; return strings.TrimSpace(p.BaseURL) }

func (c Config) ResolveModel(providerName, modelName string) (ModelSelection, error) { return c.resolveModel(providerName, modelName, os.LookupEnv) }
func (c Config) ResolveModelWithEnv(providerName, modelName string, lookup func(string) (string, bool)) (ModelSelection, error) { return c.resolveModel(providerName, modelName, lookup) }
func (c Config) resolveModel(providerName, modelName string, lookup lookupEnv) (ModelSelection, error) {
    providerName = strings.TrimSpace(providerName); if providerName == "" { providerName = strings.TrimSpace(c.Runtime.DefaultProvider) }; if providerName == "" && len(c.Providers) == 0 { providerName = "deterministic" }
    p, ok := c.Providers[providerName]; if !ok && providerName == "deterministic" && len(c.Providers) == 0 { p = ProviderProfile{Name: "deterministic", Model: "stub"}; ok = true }; if !ok { return ModelSelection{}, fmt.Errorf("provider %q is not configured", providerName) }
    modelName = strings.TrimSpace(modelName); if modelName == "" { modelName = strings.TrimSpace(c.Runtime.DefaultModel) }; if modelName == "" { modelName = strings.TrimSpace(p.Model) }; if modelName == "" { modelName = "stub" }
    caps := p.InputCapabilities; if caps == nil { caps = p.Input }; result := ModelSelection{ProfileID: providerName + ":" + modelName, Provider: providerName, Model: modelName, ReasoningEffort: p.ReasoningEffort, MaxTokens: p.MaxTokens, InputCapabilities: append([]string(nil), caps...), BaseURL: p.EffectiveBaseURL(lookup), APIKeyEnv: p.APIKeyEnv, Timeout: p.Timeout, MaxRetries: p.MaxRetries, RetryBackoff: p.RetryBackoff, Streaming: p.Streaming}
    if m, exists := c.Models[modelName]; exists { result.ProfileID = modelName; if err := applyModel(&result, m, providerName, modelName, lookup); err != nil { return ModelSelection{}, err } }
    if m, exists := p.Models[modelName]; exists { result.ProfileID = providerName + ":" + modelName; if err := applyModel(&result, m, providerName, modelName, lookup); err != nil { return ModelSelection{}, err } }
    if result.ReasoningEffort == "" { result.ReasoningEffort = c.Runtime.DefaultReasoningEffort }; if result.MaxTokens == 0 { result.MaxTokens = c.Runtime.MaxTokens }; return result, nil
}
func applyModel(result *ModelSelection, m ModelProfile, providerName, modelName string, lookup lookupEnv) error { if m.Provider != "" && m.Provider != providerName { return fmt.Errorf("model %q belongs to provider %q", modelName, m.Provider) }; if m.Model != "" { result.Model = m.Model }; if m.ReasoningEffort != "" { result.ReasoningEffort = m.ReasoningEffort }; if m.MaxTokens != 0 { result.MaxTokens = m.MaxTokens }; if m.Timeout != 0 { result.Timeout = m.Timeout }; if m.MaxRetries != 0 { result.MaxRetries = m.MaxRetries }; if m.RetryBackoff != 0 { result.RetryBackoff = m.RetryBackoff }; if m.Streaming != nil { result.Streaming = *m.Streaming }; caps := m.InputCapabilities; if caps == nil { caps = m.Input }; if caps != nil { result.InputCapabilities = append([]string(nil), caps...) }; if m.BaseURL != "" { result.BaseURL = m.BaseURL }; if m.BaseURLEnv != "" && lookup != nil { if v, ok := lookup(m.BaseURLEnv); ok && strings.TrimSpace(v) != "" { result.BaseURL = strings.TrimSpace(v) } }; return nil }

// Manager atomically swaps only validated configuration snapshots.
type Manager struct { mu sync.RWMutex; path string; lookup lookupEnv; cfg Config }
func NewManager(path string) (*Manager, error) { lookup := os.LookupEnv; cfg, err := load(path, lookup); if err != nil { return nil, err }; if path == "" { path, _ = lookup("DEEPSTUDENT_CONFIG") }; return &Manager{path: path, lookup: lookup, cfg: cloneConfig(cfg)}, nil }
func (m *Manager) Config() Config { m.mu.RLock(); defer m.mu.RUnlock(); return cloneConfig(m.cfg) }
func (m *Manager) Reload() error { cfg, err := load(m.path, m.lookup); if err != nil { return err }; m.mu.Lock(); m.cfg = cloneConfig(cfg); m.mu.Unlock(); return nil }
func cloneConfig(cfg Config) Config { out := cfg; out.Server.CORSAllowlist = append([]string(nil), cfg.Server.CORSAllowlist...); out.Storage.AttachmentAllowedMIMEs = append([]string(nil), cfg.Storage.AttachmentAllowedMIMEs...); out.Models = map[string]ModelProfile{}; for id, m := range cfg.Models { out.Models[id] = cloneModel(m) }; out.Providers = map[string]ProviderProfile{}; for name, p := range cfg.Providers { p.Input = append([]string(nil), p.Input...); p.InputCapabilities = append([]string(nil), p.InputCapabilities...); p.Models = map[string]ModelProfile{}; for id, m := range p.Models { p.Models[id] = cloneModel(m) }; out.Providers[name] = p }; return out }
func cloneModel(m ModelProfile) ModelProfile { m.Input = append([]string(nil), m.Input...); m.InputCapabilities = append([]string(nil), m.InputCapabilities...); return m }
