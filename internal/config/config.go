// Package config owns the server's non-secret configuration model and load order.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const DefaultVersion = "v1"

// Config is intentionally composed of values safe to keep in logs. Provider
// credentials are referenced by environment variable name and are never
// loaded into this structure.
type Config struct {
	Version   string                     `json:"version"`
	Server    ServerConfig               `json:"server"`
	Storage   StorageConfig              `json:"storage"`
	Runtime   RuntimeConfig              `json:"runtime"`
	Auth      AuthConfig                 `json:"auth"`
	Providers map[string]ProviderProfile `json:"providers"`
}

type ServerConfig struct {
	Addr          string        `json:"addr"`
	ReadTimeout   time.Duration `json:"readTimeout"`
	WriteTimeout  time.Duration `json:"writeTimeout"`
	IdleTimeout   time.Duration `json:"idleTimeout"`
	CORSAllowlist []string      `json:"corsAllowlist"`
}

type StorageConfig struct {
	SQLitePath string `json:"sqlitePath"`
}

type RuntimeConfig struct {
	DefaultProvider string        `json:"defaultProvider"`
	DefaultTimeout  time.Duration `json:"defaultTimeout"`
	MaxTokens       int           `json:"maxTokens"`
	MaxConcurrency  int           `json:"maxConcurrency"`
}

type AuthConfig struct {
	Enabled      bool          `json:"enabled"`
	CookieName   string        `json:"cookieName"`
	CookieSecure bool          `json:"cookieSecure"`
	SessionTTL   time.Duration `json:"sessionTTL"`
}

// ProviderProfile contains provider metadata only. API keys belong in the
// environment and are intentionally represented by APIKeyEnv, never a value.
type ProviderProfile struct {
	Name      string        `json:"name"`
	BaseURL   string        `json:"baseURL"`
	Model     string        `json:"model"`
	APIKeyEnv string        `json:"apiKeyEnv"`
	Timeout   time.Duration `json:"timeout"`
}

func Defaults() Config {
	return Config{
		Version: DefaultVersion,
		Server: ServerConfig{
			Addr:          "127.0.0.1:8080",
			ReadTimeout:   15 * time.Second,
			// SSE streams are long-lived; net/http applies WriteTimeout to the
			// entire response and would truncate a valid run after 30 seconds.
			// Keep it disabled by default and rely on runtime/provider deadlines.
			WriteTimeout:  0,
			IdleTimeout:   60 * time.Second,
			CORSAllowlist: []string{"http://127.0.0.1:5173", "http://localhost:5173"},
		},
		Storage: StorageConfig{SQLitePath: "data/deepstudent.db"},
		Runtime: RuntimeConfig{
			DefaultProvider: "deterministic",
			DefaultTimeout:  45 * time.Second,
			MaxTokens:       2048,
			MaxConcurrency:  2,
		},
		Auth: AuthConfig{
			CookieName: "deepstudent_session",
			SessionTTL: 24 * time.Hour,
		},
		Providers: map[string]ProviderProfile{
			"deterministic": {Name: "deterministic", Model: "stub", Timeout: 45 * time.Second},
		},
	}
}

// Load reads an optional JSON config file, then applies environment overrides.
// Environment values always win over file values, which win over defaults.
// The path is optional; DEEPSTUDENT_CONFIG is used when path is empty.
func Load(path string) (Config, error) {
	cfg := Defaults()
	if path == "" {
		path = os.Getenv("DEEPSTUDENT_CONFIG")
	}
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return cfg, fmt.Errorf("config file %q: %w", path, err)
			}
			return cfg, err
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("parse config file %q: %w", path, err)
		}
		if cfg.Providers == nil {
			cfg.Providers = map[string]ProviderProfile{}
		}
	}
	if err := applyEnv(&cfg, os.LookupEnv); err != nil {
		return cfg, err
	}
	return cfg, Validate(cfg)
}

type lookupEnv func(string) (string, bool)

func applyEnv(cfg *Config, lookup lookupEnv) error {
	if v, ok := lookup("DEEPSTUDENT_HTTP_ADDR"); ok {
		cfg.Server.Addr = v
	}
	if v, ok := lookup("DEEPSTUDENT_DB_PATH"); ok {
		cfg.Storage.SQLitePath = v
	}
	if v, ok := lookup("DEEPSTUDENT_CORS_ALLOWLIST"); ok {
		cfg.Server.CORSAllowlist = splitList(v)
	}
	if v, ok := lookup("DEEPSTUDENT_DEFAULT_PROVIDER"); ok {
		cfg.Runtime.DefaultProvider = v
	}
	if v, ok := lookup("DEEPSTUDENT_DEFAULT_TIMEOUT"); ok {
		d, err := time.ParseDuration(v)
		if err != nil {
			return fmt.Errorf("DEEPSTUDENT_DEFAULT_TIMEOUT: %w", err)
		}
		cfg.Runtime.DefaultTimeout = d
	}
	if v, ok := lookup("DEEPSTUDENT_MAX_TOKENS"); ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("DEEPSTUDENT_MAX_TOKENS: %w", err)
		}
		cfg.Runtime.MaxTokens = n
	}
	if v, ok := lookup("DEEPSTUDENT_MAX_CONCURRENCY"); ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("DEEPSTUDENT_MAX_CONCURRENCY: %w", err)
		}
		cfg.Runtime.MaxConcurrency = n
	}
	if v, ok := lookup("DEEPSTUDENT_AUTH_ENABLED"); ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("DEEPSTUDENT_AUTH_ENABLED: %w", err)
		}
		cfg.Auth.Enabled = b
	}
	if v, ok := lookup("DEEPSTUDENT_COOKIE_SECURE"); ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("DEEPSTUDENT_COOKIE_SECURE: %w", err)
		}
		cfg.Auth.CookieSecure = b
	}
	return nil
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func Validate(cfg Config) error {
	if strings.TrimSpace(cfg.Server.Addr) == "" {
		return errors.New("server addr must not be empty")
	}
	if cfg.Storage.SQLitePath == "" {
		return errors.New("storage sqlitePath must not be empty")
	}
	if cfg.Runtime.DefaultTimeout <= 0 {
		return errors.New("runtime defaultTimeout must be positive")
	}
	if cfg.Runtime.MaxTokens <= 0 {
		return errors.New("runtime maxTokens must be positive")
	}
	if cfg.Runtime.MaxConcurrency <= 0 {
		return errors.New("runtime maxConcurrency must be positive")
	}
	if cfg.Auth.SessionTTL <= 0 {
		return errors.New("auth sessionTTL must be positive")
	}
	return nil
}
