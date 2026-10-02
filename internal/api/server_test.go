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
