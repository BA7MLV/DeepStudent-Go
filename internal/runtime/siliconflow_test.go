package runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSiliconFlowStreamsOpenAICompatibleSSE(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var request siliconFlowRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if request.Model != "Qwen/test" || !request.Stream || len(request.Messages) != 1 {
			t.Errorf("unexpected request: %+v", request)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	provider := NewSiliconFlowProvider(SiliconFlowConfig{BaseURL: server.URL, APIKeyEnv: "TEST_KEY", Model: "Qwen/test", LookupEnv: func(name string) (string, bool) { return "test-key", name == "TEST_KEY" }})
	var events []StreamEvent
	err := provider.Stream(context.Background(), ModelRequest{Prompt: "hi"}, func(event StreamEvent) error { events = append(events, event); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer test-key" || len(events) != 2 || events[0].Delta != "hello" || events[1].Delta != " world" {
		t.Fatalf("auth/events mismatch: %q %+v", gotAuth, events)
	}
}

func TestSiliconFlowRetriesTransientHTTPStatus(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	provider := NewSiliconFlowProvider(SiliconFlowConfig{BaseURL: server.URL, APIKeyEnv: "TEST_KEY", Model: "test", MaxRetries: 1, RetryBackoff: time.Millisecond, LookupEnv: func(string) (string, bool) { return "k", true }})
	var text strings.Builder
	err := provider.Stream(context.Background(), ModelRequest{Prompt: "hi"}, func(event StreamEvent) error { text.WriteString(event.Delta); return nil })
	if err != nil || attempts.Load() != 2 || text.String() != "ok" {
		t.Fatalf("retry failed: err=%v attempts=%d text=%q", err, attempts.Load(), text.String())
	}
}

func TestSiliconFlowDoesNotRequireCredentialUntilStream(t *testing.T) {
	provider := NewSiliconFlowProvider(SiliconFlowConfig{BaseURL: "http://127.0.0.1:1", APIKeyEnv: "MISSING", LookupEnv: func(string) (string, bool) { return "", false }})
	if err := provider.Stream(context.Background(), ModelRequest{Prompt: "hi"}, func(StreamEvent) error { return nil }); err == nil || !strings.Contains(err.Error(), "MISSING") {
		t.Fatalf("expected missing environment error, got %v", err)
	}
}
