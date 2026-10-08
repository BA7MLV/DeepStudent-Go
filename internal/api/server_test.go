package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/storage"
)

func TestHealthAndRequestID(t *testing.T) {
	server := NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Request-ID", "test-request")
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	if res.Code != http.StatusOK || res.Header().Get("X-Request-ID") != "test-request" {
		t.Fatalf("unexpected response: %d %v", res.Code, res.Header())
	}
}

func TestRunSSE(t *testing.T) {
	server := NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	res := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/runs", strings.NewReader(`{"prompt":"hello"}`))
	server.ServeHTTP(res, req)
	if res.Code != http.StatusAccepted {
		t.Fatalf("start status %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		EventsURL string `json:"events_url"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	eventsReq := httptest.NewRequest(http.MethodGet, body.EventsURL, nil)
	eventsRes := httptest.NewRecorder()
	server.ServeHTTP(eventsRes, eventsReq)
	if eventsRes.Code != http.StatusOK || !strings.Contains(eventsRes.Body.String(), "run.completed") {
		t.Fatalf("unexpected SSE response: %d %s", eventsRes.Code, eventsRes.Body.String())
	}
}

func TestConfigRouteUpdatesDefaultModel(t *testing.T) {
	server := NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	get := httptest.NewRecorder()
	server.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/v1/config", nil))
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"deterministic"`) {
		t.Fatalf("config GET = %d %s", get.Code, get.Body.String())
	}
	patch := httptest.NewRecorder()
	server.ServeHTTP(patch, httptest.NewRequest(http.MethodPatch, "/api/v1/config", strings.NewReader(`{"provider":"deterministic","model":"stub-v2"}`)))
	if patch.Code != http.StatusOK || !strings.Contains(patch.Body.String(), `"default_model":"stub-v2"`) {
		t.Fatalf("config PATCH = %d %s", patch.Code, patch.Body.String())
	}
	run := httptest.NewRecorder()
	server.ServeHTTP(run, httptest.NewRequest(http.MethodPost, "/api/v1/runs", strings.NewReader(`{"prompt":"uses updated route"}`)))
	if run.Code != http.StatusAccepted || !strings.Contains(run.Body.String(), `"model":"stub-v2"`) {
		t.Fatalf("run after config PATCH = %d %s", run.Code, run.Body.String())
	}
}

func TestConfigRouteUpdatesProviderEndpointAndEnvironmentName(t *testing.T) {
	server := NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	patch := httptest.NewRecorder()
	server.ServeHTTP(patch, httptest.NewRequest(http.MethodPatch, "/api/v1/config", strings.NewReader(`{"provider":"deepseek","model":"deepseek-test","base_url":"https://example.test/v1","api_key_env":"MY_DEEPSEEK_KEY"}`)))
	if patch.Code != http.StatusOK || !strings.Contains(patch.Body.String(), `"base_url":"https://example.test/v1"`) || !strings.Contains(patch.Body.String(), `"api_key_env":"MY_DEEPSEEK_KEY"`) {
		t.Fatalf("provider config PATCH = %d %s", patch.Code, patch.Body.String())
	}
	run := httptest.NewRecorder()
	server.ServeHTTP(run, httptest.NewRequest(http.MethodPost, "/api/v1/runs", strings.NewReader(`{"prompt":"uses provider override"}`)))
	if run.Code != http.StatusAccepted || !strings.Contains(run.Body.String(), `"provider":"deepseek"`) || !strings.Contains(run.Body.String(), `"model":"deepseek-test"`) {
		t.Fatalf("run after provider PATCH = %d %s", run.Code, run.Body.String())
	}
}

func TestConfigRouteRejectsCredentialInBaseURL(t *testing.T) {
	server := NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	res := httptest.NewRecorder()
	server.ServeHTTP(res, httptest.NewRequest(http.MethodPatch, "/api/v1/config", strings.NewReader(`{"provider":"deepseek","base_url":"https://user:secret@example.test/v1"}`)))
	if res.Code != http.StatusBadRequest {
		t.Fatalf("credential-bearing base URL status = %d, body=%s", res.Code, res.Body.String())
	}
}

func TestConfigRoutePersistsAcrossRestartAndRunUsesSelection(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "deepstudent.db")
	cfg := config.Defaults()
	cfg.Storage.SQLitePath = dbPath
	store, err := storage.OpenSQLite(context.Background(), dbPath)
	if err != nil { t.Fatal(err) }
	runs := runtime.NewDeterministicRuntime(nil, store, 1)
	server := NewServer(cfg, runs, store)
	patch := httptest.NewRecorder()
	server.ServeHTTP(patch, httptest.NewRequest(http.MethodPatch, "/api/v1/config", strings.NewReader(`{"provider":"deterministic","model":"persisted-stub"}`)))
	if patch.Code != http.StatusOK { t.Fatalf("config PATCH = %d %s", patch.Code, patch.Body.String()) }
	_ = store.Close()

	reopened, err := storage.OpenSQLite(context.Background(), dbPath)
	if err != nil { t.Fatal(err) }
	defer reopened.Close()
	restored, err := reopened.LoadConfig(context.Background(), cfg)
	if err != nil { t.Fatal(err) }
	second := NewServer(restored, runtime.NewDeterministicRuntime(nil, reopened, 1), reopened)
	get := httptest.NewRecorder()
	second.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/v1/config", nil))
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"default_model":"persisted-stub"`) { t.Fatalf("restored config = %d %s", get.Code, get.Body.String()) }
	run := httptest.NewRecorder()
	second.ServeHTTP(run, httptest.NewRequest(http.MethodPost, "/api/v1/runs", strings.NewReader(`{"prompt":"after restart"}`)))
	if run.Code != http.StatusAccepted || !strings.Contains(run.Body.String(), `"model":"persisted-stub"`) { t.Fatalf("restored run = %d %s", run.Code, run.Body.String()) }
}

func TestConfigConnectionTestDeterministicAndOpenAICompatible(t *testing.T) {
	called := make(chan struct{}, 1)
	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer test-secret" { w.WriteHeader(http.StatusUnauthorized); return }
		called <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer providerServer.Close()
	t.Setenv("TEST_CONNECTION_KEY", "test-secret")
	cfg := config.Defaults()
	cfg.Providers["deepseek"] = config.ProviderProfile{Name: "deepseek", BaseURL: providerServer.URL + "/v1", APIKeyEnv: "TEST_CONNECTION_KEY", Model: "test-model"}
	server := NewServer(cfg, runtime.NewDeterministicRuntime(nil, nil, 1))
	remote := httptest.NewRecorder()
	server.ServeHTTP(remote, httptest.NewRequest(http.MethodPost, "/api/v1/config/test", strings.NewReader(`{"provider":"deepseek"}`)))
	if remote.Code != http.StatusOK || strings.Contains(remote.Body.String(), "test-secret") { t.Fatalf("remote connection test = %d %s", remote.Code, remote.Body.String()) }
	select { case <-called: default: t.Fatal("provider endpoint was not probed") }
	deterministic := httptest.NewRecorder()
	server.ServeHTTP(deterministic, httptest.NewRequest(http.MethodPost, "/api/v1/config/test", strings.NewReader(`{"provider":"deterministic"}`)))
	if deterministic.Code != http.StatusOK || !strings.Contains(deterministic.Body.String(), `"ok":true`) { t.Fatalf("deterministic connection test = %d %s", deterministic.Code, deterministic.Body.String()) }
}

func TestPiDiscoveryRouteIsCredentialFree(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	server := NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	res := httptest.NewRecorder()
	server.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/pi/discovery", nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"current_mode":"auto"`) { t.Fatalf("discovery = %d %s", res.Code, res.Body.String()) }
	if strings.Contains(strings.ToLower(res.Body.String()), "api_key") { t.Fatalf("discovery leaked credential metadata: %s", res.Body.String()) }
}
