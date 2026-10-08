package storage

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
)

func TestSQLiteConfigRoundTripPersistsCredentialFreeRouting(t *testing.T) {
	ctx := context.Background()
	t.Setenv("DEEPSEEK_TEST_KEY", "DEEPSEEK_TEST_SECRET")
	dbPath := filepath.Join(t.TempDir(), "deepstudent.db")
	store, err := OpenSQLite(ctx, dbPath)
	if err != nil { t.Fatal(err) }
	cfg := config.Defaults()
	cfg.Runtime.DefaultProvider = "deepseek"
	cfg.Runtime.DefaultModel = "deepseek-test"
	cfg.Providers["deepseek"].BaseURL = "https://gateway.example/v1"
	cfg.Providers["deepseek"].APIKeyEnv = "DEEPSEEK_TEST_KEY"
	if err := store.SaveConfig(ctx, cfg); err != nil { t.Fatal(err) }
	if err := store.Close(); err != nil { t.Fatal(err) }

	reopened, err := OpenSQLite(ctx, dbPath)
	if err != nil { t.Fatal(err) }
	defer reopened.Close()
	restored, err := reopened.LoadConfig(ctx, config.Defaults())
	if err != nil { t.Fatal(err) }
	if restored.Runtime.DefaultProvider != "deepseek" || restored.Runtime.DefaultModel != "deepseek-test" {
		t.Fatalf("restored runtime = %+v", restored.Runtime)
	}
	if got := restored.Providers["deepseek"].BaseURL; got != "https://gateway.example/v1" { t.Fatalf("restored endpoint = %q", got) }
	if got := restored.Providers["deepseek"].APIKeyEnv; got != "DEEPSEEK_TEST_KEY" { t.Fatalf("restored key env = %q", got) }
	var raw string
	if err := reopened.DB().QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, configSettingKey).Scan(&raw); err != nil { t.Fatal(err) }
	if strings.Contains(raw, "DEEPSEEK_TEST_SECRET") { t.Fatal("persisted config contains a credential value") }
}
