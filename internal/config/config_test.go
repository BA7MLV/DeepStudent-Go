package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvironmentOverridesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"server":{"addr":"127.0.0.1:9999"},"runtime":{"maxTokens":99}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DEEPSTUDENT_HTTP_ADDR", "127.0.0.1:8123")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Addr != "127.0.0.1:8123" || cfg.Runtime.MaxTokens != 99 {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestValidateRejectsUnsafeLimits(t *testing.T) {
	cfg := Defaults()
	cfg.Runtime.MaxConcurrency = 0
	if err := Validate(cfg); err == nil {
		t.Fatal("expected invalid concurrency")
	}
}

func TestLoadResolvesModelProfileAndEndpointEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data := []byte(`{"runtime":{"defaultProvider":"gateway"},"providers":{"gateway":{"base_url":"https://gateway.example/v1","base_url_env":"GATEWAY_URL","models":{"vision":{"model":"vision-v2","reasoning_effort":"high","max_tokens":512,"input":["text","image"]}}}}}`)
	if err := os.WriteFile(path, data, 0o600); err != nil { t.Fatal(err) }
	t.Setenv("GATEWAY_URL", "https://override.example/v1")
	cfg, err := Load(path)
	if err != nil { t.Fatal(err) }
	selection, err := cfg.ResolveModel("gateway", "vision")
	if err != nil { t.Fatal(err) }
	if selection.Model != "vision-v2" || selection.ReasoningEffort != "high" || selection.MaxTokens != 512 || selection.BaseURL != "https://override.example/v1" { t.Fatalf("unexpected selection: %+v", selection) }
	if len(selection.InputCapabilities) != 2 { t.Fatalf("unexpected capabilities: %+v", selection.InputCapabilities) }
}

func TestManagerKeepsLastGoodSnapshotOnReloadFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"runtime":{"maxTokens":1234}}`), 0o600); err != nil { t.Fatal(err) }
	manager, err := NewManager(path)
	if err != nil { t.Fatal(err) }
	if got := manager.Config().Runtime.MaxTokens; got != 1234 { t.Fatalf("initial max tokens = %d", got) }
	if err := os.WriteFile(path, []byte(`{"runtime":{"maxTokens":0}}`), 0o600); err != nil { t.Fatal(err) }
	if err := manager.Reload(); err == nil { t.Fatal("expected reload validation error") }
	if got := manager.Config().Runtime.MaxTokens; got != 1234 { t.Fatalf("snapshot replaced: %d", got) }
}
