package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPiSidecarConfigurationUsesSafeLocalDefault(t *testing.T) {
	cfg := Defaults()
	if cfg.Runtime.PiEndpoint != "" || cfg.Runtime.PiSkipStart || cfg.Runtime.PiMode != "" {
		t.Fatalf("Pi sidecar should be opt-in: %+v", cfg.Runtime)
	}
	if err := Validate(cfg); err != nil {
		t.Fatal(err)
	}
}

func TestLoadPiSidecarEndpointEnvironment(t *testing.T) {
	t.Setenv("DEEPSTUDENT_PI_ENDPOINT", "http://pi-sidecar:8787")
	t.Setenv("DEEPSTUDENT_PI_SKIP_START", "1")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Runtime.PiEndpoint != "http://pi-sidecar:8787" || !cfg.Runtime.PiSkipStart {
		t.Fatalf("unexpected Pi runtime config: %+v", cfg.Runtime)
	}
}

func TestValidateRequiresManagedPiCommand(t *testing.T) {
	cfg := Defaults()
	cfg.Runtime.PiMode = "managed"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected managed Pi mode without command to fail")
	}
	cfg.Runtime.PiMode = "external"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected external Pi mode without endpoint to fail")
	}
}

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

func TestDefaultsExposeCredentialFreeProviderPresets(t *testing.T) {
	cfg := Defaults()
	for _, name := range []string{"siliconflow", "deepseek", "custom-openai"} {
		if _, ok := cfg.Providers[name]; !ok {
			t.Fatalf("missing provider preset %q", name)
		}
	}
	selection, err := cfg.ResolveModel("siliconflow", "")
	if err != nil {
		t.Fatal(err)
	}
	if selection.APIKeyEnv != "SILICONFLOW_API_KEY" || selection.BaseURL == "" || selection.MaxRetries == 0 || !selection.Streaming {
		t.Fatalf("unexpected SiliconFlow selection: %+v", selection)
	}
}

func TestLoadAttachmentStorageOverrides(t *testing.T) {
	t.Setenv("DEEPSTUDENT_BLOB_ROOT", "/var/lib/deepstudent/blobs")
	t.Setenv("DEEPSTUDENT_ATTACHMENT_MAX_BYTES", "4096")
	t.Setenv("DEEPSTUDENT_ATTACHMENT_ALLOWED_MIME", "text/plain,image/*")
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Storage.BlobRoot != "/var/lib/deepstudent/blobs" || cfg.Storage.AttachmentMaxBytes != 4096 {
		t.Fatalf("unexpected attachment storage: %+v", cfg.Storage)
	}
	if len(cfg.Storage.AttachmentAllowedMIMEs) != 2 || cfg.Storage.AttachmentAllowedMIMEs[1] != "image/*" {
		t.Fatalf("unexpected MIME policy: %+v", cfg.Storage.AttachmentAllowedMIMEs)
	}
}
