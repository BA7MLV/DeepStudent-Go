package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
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
