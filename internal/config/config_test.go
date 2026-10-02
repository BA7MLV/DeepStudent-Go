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
