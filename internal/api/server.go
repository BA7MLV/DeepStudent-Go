// Package api exposes the versioned HTTP and SSE transport.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
)

const apiVersion = "v1"

type Server struct {
	cfg   config.Config
	runs  runtime.AgentRuntime
	ready atomic.Bool
	now   func() time.Time
}

func NewServer(cfg config.Config, runs runtime.AgentRuntime) *Server {
	s := &Server{cfg: cfg, runs: runs, now: time.Now}
	s.ready.Store(runs != nil)
	return s
}

func (s *Server) SetReady(ready bool) { s.ready.Store(ready) }
func (s *Server) Ready() bool         { return s.ready.Load() }

func (s *Server) Handler() http.Handler { return s }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := requestID(r.Header.Get("X-Request-ID"))
	w.Header().Set("X-Request-ID", requestID)
	if !s.cors(w, r) {
		writeError(w, requestID, http.StatusForbidden, "cors_denied", "origin is not allowed", nil)
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	switch {
	case r.URL.Path == "/healthz":
		s.health(w, requestID)
	case r.URL.Path == "/readyz":
		s.readyz(w, requestID)
	case r.URL.Path == "/api/v1" || r.URL.Path == "/api/v1/":
		if r.Method != http.MethodGet {
			writeError(w, requestID, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed", nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"version": apiVersion, "service": "deepstudent-api", "request_id": requestID})
	case r.URL.Path == "/api/v1/runs" && r.Method == http.MethodPost:
		s.startRun(w, r, requestID)
	case strings.HasPrefix(r.URL.Path, "/api/v1/runs/") && strings.HasSuffix(r.URL.Path, "/events") && r.Method == http.MethodGet:
		s.streamRun(w, r, requestID)
	default:
		writeError(w, requestID, http.StatusNotFound, "not_found", "route not found", nil)
	}
}

func (s *Server) health(w http.ResponseWriter, requestID string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"service":    "deepstudent-api",
		"version":    apiVersion,
		"runtime":    "go",
		"request_id": requestID,
		"time":       s.now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *Server) readyz(w http.ResponseWriter, requestID string) {
	if !s.ready.Load() {
		writeError(w, requestID, http.StatusServiceUnavailable, "not_ready", "runtime is not ready", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "request_id": requestID})
}

type runRequest struct {
	SessionID string `json:"session_id,omitempty"`
	Prompt    string `json:"prompt"`
	Model     string `json:"model,omitempty"`
	MaxTokens int    `json:"max_tokens,omitempty"`
}

func (s *Server) startRun(w http.ResponseWriter, r *http.Request, requestID string) {
	if s.runs == nil {
		writeError(w, requestID, http.StatusServiceUnavailable, "runtime_unavailable", "runtime is unavailable", nil)
		return
	}
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	defer body.Close()
	var input runRequest
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(&input); err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_json", "request body must be valid JSON", nil)
		return
	}
	if strings.TrimSpace(input.Prompt) == "" {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "prompt is required", nil)
		return
	}
	if input.MaxTokens < 0 {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "max_tokens must not be negative", nil)
		return
	}
	if input.MaxTokens == 0 {
		input.MaxTokens = s.cfg.Runtime.MaxTokens
	}
	if s.cfg.Runtime.MaxTokens > 0 && input.MaxTokens > s.cfg.Runtime.MaxTokens {
		writeError(w, requestID, http.StatusBadRequest, "token_limit_exceeded", "max_tokens exceeds the configured limit", map[string]any{"max_tokens": s.cfg.Runtime.MaxTokens})
		return
	}
	run, err := s.runs.Start(context.Background(), runtime.AgentRunRequest{SessionID: input.SessionID, Prompt: input.Prompt, Model: input.Model, MaxTokens: input.MaxTokens})
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "run_start_failed", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"run_id":     run.ID,
		"session_id": run.SessionID,
		"events_url": "/api/v1/runs/" + run.ID + "/events",
		"request_id": requestID,
	})
}

func (s *Server) streamRun(w http.ResponseWriter, r *http.Request, requestID string) {
	if s.runs == nil {
		writeError(w, requestID, http.StatusServiceUnavailable, "runtime_unavailable", "runtime is unavailable", nil)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/runs/")
	runID := strings.TrimSuffix(path, "/events")
	if runID == "" || strings.Contains(runID, "/") {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "run id is required", nil)
		return
	}
	events, err := s.runs.Subscribe(r.Context(), runID)
	if err != nil {
		writeError(w, requestID, http.StatusNotFound, "run_not_found", "run not found", nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Request-ID", requestID)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, requestID, http.StatusInternalServerError, "stream_unsupported", "streaming is unavailable", nil)
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n", event.ID, event.Type, data)
			flusher.Flush()
		}
	}
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	for _, allowed := range s.cfg.Server.CORSAllowlist {
		if origin == allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Request-ID")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID")
			return true
		}
	}
	return false
}

type errorBody struct {
	Error errorDetail `json:"error"`
}
type errorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Details   any    `json:"details,omitempty"`
}

func writeError(w http.ResponseWriter, requestID string, status int, code, message string, details any) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message, RequestID: requestID, Details: details}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestID(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate != "" && len(candidate) <= 128 && !strings.ContainsAny(candidate, "\r\n") {
		return candidate
	}
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("req-%d", time.Now().UnixNano())
	}
	return "req-" + hex.EncodeToString(bytes[:])
}
