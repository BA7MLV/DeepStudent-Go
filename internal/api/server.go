// Package api exposes the versioned HTTP and SSE transport.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
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
	store runtime.SessionStore
	ready atomic.Bool
	now   func() time.Time
}

func NewServer(cfg config.Config, runs runtime.AgentRuntime, stores ...runtime.SessionStore) *Server {
	var store runtime.SessionStore
	if len(stores) > 0 {
		store = stores[0]
	}
	s := &Server{cfg: cfg, runs: runs, store: store, now: time.Now}
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
	case r.URL.Path == "/api/v1/sessions" && r.Method == http.MethodGet:
		s.listSessions(w, r, requestID)
	case r.URL.Path == "/api/v1/sessions" && r.Method == http.MethodPost:
		s.createSession(w, r, requestID)
	case strings.HasPrefix(r.URL.Path, "/api/v1/sessions/"):
		s.sessionRoute(w, r, requestID)
	case strings.HasPrefix(r.URL.Path, "/api/v1/runs/") && strings.HasSuffix(r.URL.Path, "/cancel") && r.Method == http.MethodPost:
		s.cancelRun(w, r, requestID)
	case strings.HasPrefix(r.URL.Path, "/api/v1/runs/") && !strings.HasSuffix(r.URL.Path, "/events") && r.Method == http.MethodGet:
		s.getRun(w, r, requestID)
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
	SessionID         string   `json:"session_id,omitempty"`
	Prompt            string   `json:"prompt"`
	Content           string   `json:"content,omitempty"`
	MessageID         string   `json:"message_id,omitempty"`
	ClientMessageID   string   `json:"client_message_id,omitempty"`
	Provider          string   `json:"provider,omitempty"`
	Model             string   `json:"model,omitempty"`
	ReasoningEffort   string   `json:"reasoning_effort,omitempty"`
	MaxTokens         int      `json:"max_tokens,omitempty"`
	InputCapabilities []string `json:"input_capabilities,omitempty"`
	Input             []string `json:"input,omitempty"`
}

func (s *Server) startRun(w http.ResponseWriter, r *http.Request, requestID string) {
	if s.runs == nil {
		writeError(w, requestID, http.StatusServiceUnavailable, "runtime_unavailable", "runtime is unavailable", nil)
		return
	}
	body := http.MaxBytesReader(w, r.Body, 1<<20)
	defer body.Close()
	var input runRequest
	if err := decodeJSON(body, &input); err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_json", "request body must be valid JSON", nil)
		return
	}
	s.startRunInput(w, r, requestID, input)
}

func (s *Server) startRunInput(w http.ResponseWriter, r *http.Request, requestID string, input runRequest) {
	if strings.TrimSpace(input.Prompt) == "" {
		input.Prompt = input.Content
	}
	if strings.TrimSpace(input.Prompt) == "" {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "prompt is required", nil)
		return
	}
	if strings.TrimSpace(input.SessionID) == "" && s.store != nil {
		input.SessionID = newID("session")
	}
	if input.MaxTokens < 0 {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "max_tokens must not be negative", nil)
		return
	}
	selection, err := s.cfg.ResolveModel(input.Provider, input.Model)
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_model", err.Error(), nil)
		return
	}
	if strings.TrimSpace(input.Provider) == "" {
		input.Provider = selection.Provider
	}
	if strings.TrimSpace(input.Model) == "" {
		input.Model = selection.Model
	}
	if strings.TrimSpace(input.ReasoningEffort) == "" {
		input.ReasoningEffort = selection.ReasoningEffort
	}
	if input.MaxTokens == 0 {
		input.MaxTokens = selection.MaxTokens
	}
	if input.InputCapabilities == nil {
		input.InputCapabilities = input.Input
	}
	if input.InputCapabilities == nil {
		input.InputCapabilities = selection.InputCapabilities
	}
	if s.cfg.Runtime.MaxTokens > 0 && input.MaxTokens > s.cfg.Runtime.MaxTokens {
		writeError(w, requestID, http.StatusBadRequest, "token_limit_exceeded", "max_tokens exceeds the configured limit", map[string]any{"max_tokens": s.cfg.Runtime.MaxTokens})
		return
	}
	var requestedRunID string
	if catalog, ok := s.store.(runtime.SessionCatalog); ok && input.SessionID != "" {
		messageID := strings.TrimSpace(input.MessageID)
		if messageID == "" {
			messageID = strings.TrimSpace(input.ClientMessageID)
		}
		// Retries from an offline outbox may arrive after the original request
		// already created a run. Reuse that run instead of emitting a duplicate
		// assistant response. Stores without MessageLookup retain old behavior.
		if messageID != "" {
			if lookup, lookupOK := s.store.(runtime.MessageLookup); lookupOK {
				if existing, lookupErr := lookup.GetMessage(r.Context(), messageID); lookupErr == nil {
					if existing.SessionID != input.SessionID || existing.Role != "user" || existing.Content != input.Prompt {
						writeError(w, requestID, http.StatusConflict, "message_id_conflict", "message id is already used for another message", nil)
						return
					}
					if existing.RunID != "" {
						s.writeAcceptedRun(w, requestID, existing.RunID, input.SessionID, selection, input)
						return
					}
				}
			}
		}
		requestedRunID = newID("run")
		message := runtime.Message{SessionID: input.SessionID, RunID: requestedRunID, Role: "user", Content: input.Prompt}
		if messageID != "" {
			message.ID = messageID
		}
		if _, err := catalog.AppendMessage(r.Context(), message); err != nil {
			writeError(w, requestID, http.StatusInternalServerError, "message_persist_failed", "could not persist user message", nil)
			return
		}
	}
	run, err := s.runs.Start(context.Background(), runtime.AgentRunRequest{
		RunID:             requestedRunID,
		SessionID:         input.SessionID,
		Prompt:            input.Prompt,
		Provider:          input.Provider,
		Model:             input.Model,
		ReasoningEffort:   input.ReasoningEffort,
		MaxTokens:         input.MaxTokens,
		InputCapabilities: input.InputCapabilities,
		Input:             input.InputCapabilities,
	})
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "run_start_failed", err.Error(), nil)
		return
	}
	s.writeAcceptedRun(w, requestID, run.ID, run.SessionID, selection, input)
}

func (s *Server) writeAcceptedRun(w http.ResponseWriter, requestID, runID, sessionID string, selection config.ModelSelection, input runRequest) {
	writeJSON(w, http.StatusAccepted, map[string]any{
		"run_id":           runID,
		"session_id":       sessionID,
		"profile_id":       selection.ProfileID,
		"provider":         input.Provider,
		"model":            input.Model,
		"reasoning_effort": input.ReasoningEffort,
		"max_tokens":       input.MaxTokens,
		"events_url":       "/api/v1/runs/" + runID + "/events",
		"request_id":       requestID,
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
	var events <-chan runtime.StreamEvent
	var err error
	if replay, ok := s.runs.(interface {
		SubscribeFrom(context.Context, string, string) (<-chan runtime.StreamEvent, error)
	}); ok {
		events, err = replay.SubscribeFrom(r.Context(), runID, strings.TrimSpace(r.Header.Get("Last-Event-ID")))
	} else {
		events, err = s.runs.Subscribe(r.Context(), runID)
	}
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
	// Tell EventSource clients how quickly to retry after a dropped connection.
	// This is advisory and does not change the durable Last-Event-ID replay
	// behavior used to recover any events produced during the disconnect.
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()
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

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request, requestID string) {
	catalog, ok := s.store.(runtime.SessionCatalog)
	if !ok {
		writeError(w, requestID, http.StatusServiceUnavailable, "storage_unavailable", "session storage is unavailable", nil)
		return
	}
	limit, offset := parsePage(r)
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		query = strings.TrimSpace(r.URL.Query().Get("search"))
	}
	var sessions []runtime.Session
	var err error
	if query != "" {
		if searcher, searchOK := s.store.(runtime.SessionSearcher); searchOK {
			sessions, err = searcher.SearchSessions(r.Context(), query, limit, offset)
		} else {
			// Keep compatibility with small stores that only implement the
			// original catalog. Their limited result set is filtered locally.
			sessions, err = catalog.ListSessions(r.Context(), limit, offset)
			if err == nil {
				filtered := sessions[:0]
				needle := strings.ToLower(query)
				for _, session := range sessions {
					if strings.Contains(strings.ToLower(session.ID), needle) || strings.Contains(strings.ToLower(session.Title), needle) {
						filtered = append(filtered, session)
					}
				}
				sessions = filtered
			}
		}
	} else {
		sessions, err = catalog.ListSessions(r.Context(), limit, offset)
	}
	if err != nil {
		writeError(w, requestID, http.StatusInternalServerError, "session_list_failed", "could not list sessions", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions, "request_id": requestID})
}

type sessionRequest struct {
	ID    string `json:"id,omitempty"`
	Title string `json:"title,omitempty"`
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request, requestID string) {
	catalog, ok := s.store.(runtime.SessionCatalog)
	if !ok {
		writeError(w, requestID, http.StatusServiceUnavailable, "storage_unavailable", "session storage is unavailable", nil)
		return
	}
	var input sessionRequest
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 64<<10), &input); err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_json", "request body must be valid JSON", nil)
		return
	}
	if strings.TrimSpace(input.ID) == "" {
		input.ID = newID("session")
	}
	session, err := catalog.CreateSessionWithTitle(r.Context(), runtime.Session{ID: input.ID, Title: strings.TrimSpace(input.Title)})
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "session_create_failed", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": session, "request_id": requestID})
}

func (s *Server) sessionRoute(w http.ResponseWriter, r *http.Request, requestID string) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/sessions/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "session id is required", nil)
		return
	}
	sessionID, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(sessionID) == "" {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "session id is invalid", nil)
		return
	}
	catalog, ok := s.store.(runtime.SessionCatalog)
	if !ok {
		writeError(w, requestID, http.StatusServiceUnavailable, "storage_unavailable", "session storage is unavailable", nil)
		return
	}
	if len(parts) == 1 && r.Method == http.MethodGet {
		session, err := catalog.GetSession(r.Context(), sessionID)
		if err != nil {
			writeError(w, requestID, http.StatusNotFound, "session_not_found", "session not found", nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"session": session, "request_id": requestID})
		return
	}
	if len(parts) == 2 && parts[1] == "messages" {
		if r.Method == http.MethodGet {
			s.listMessages(w, r, requestID, catalog, sessionID)
			return
		}
		if r.Method == http.MethodPost {
			s.postMessage(w, r, requestID, sessionID)
			return
		}
	}
	writeError(w, requestID, http.StatusNotFound, "not_found", "route not found", nil)
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, requestID string, catalog runtime.SessionCatalog, sessionID string) {
	if _, err := catalog.GetSession(r.Context(), sessionID); err != nil {
		writeError(w, requestID, http.StatusNotFound, "session_not_found", "session not found", nil)
		return
	}
	var page runtime.MessagePage
	var err error
	beforeID := strings.TrimSpace(r.URL.Query().Get("before"))
	afterID := strings.TrimSpace(r.URL.Query().Get("after"))
	limit, limitProvided := parseMessagePage(r)
	if pager, ok := s.store.(runtime.MessagePageReader); ok && (limitProvided || beforeID != "" || afterID != "") {
		page, err = pager.MessagesPage(r.Context(), sessionID, beforeID, afterID, limit)
	} else {
		var messages []runtime.Message
		messages, err = catalog.Messages(r.Context(), sessionID, time.Time{})
		if err == nil {
			// Legacy stores return one complete ascending timeline. Apply the
			// same ID cursors in memory so upgraded clients can talk to them.
			start, end := 0, len(messages)
			if beforeID != "" {
				for i, message := range messages {
					if message.ID == beforeID {
						end = i
						break
					}
				}
			} else if afterID != "" {
				for i, message := range messages {
					if message.ID == afterID {
						start = i + 1
						break
					}
				}
			}
			if start > end {
				start = end
			}
			window := messages[start:end]
			if limitProvided && len(window) > limit {
				if beforeID != "" {
					window = window[len(window)-limit:]
				} else {
					window = window[:limit]
				}
				page.HasMore = true
			}
			page.Messages = window
			if len(window) > 0 {
				page.NextBefore = window[0].ID
				page.NextAfter = window[len(window)-1].ID
			}
		}
	}
	if err != nil {
		writeError(w, requestID, http.StatusInternalServerError, "message_list_failed", "could not list messages", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"messages":    page.Messages,
		"has_more":    page.HasMore,
		"next_before": page.NextBefore,
		"next_after":  page.NextAfter,
		"request_id":  requestID,
	})
}

func parseMessagePage(r *http.Request) (int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("limit"))
	if raw == "" {
		return 50, false
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 || limit > 200 {
		return 50, true
	}
	return limit, true
}

func (s *Server) postMessage(w http.ResponseWriter, r *http.Request, requestID, sessionID string) {
	var input runRequest
	if err := decodeJSON(http.MaxBytesReader(w, r.Body, 1<<20), &input); err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_json", "request body must be valid JSON", nil)
		return
	}
	input.SessionID = sessionID
	s.startRunInput(w, r, requestID, input)
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request, requestID string) {
	runID := strings.TrimPrefix(r.URL.Path, "/api/v1/runs/")
	if runID == "" || strings.Contains(runID, "/") {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "run id is required", nil)
		return
	}
	var run runtime.RunRecord
	var err error
	if inspector, ok := s.runs.(runtime.RunInspector); ok {
		run, err = inspector.Run(r.Context(), runID)
	} else if reader, ok := s.store.(runtime.RunReader); ok {
		run, err = reader.Run(r.Context(), runID)
	} else {
		writeError(w, requestID, http.StatusNotImplemented, "run_status_unavailable", "run status is unavailable", nil)
		return
	}
	if err != nil {
		writeError(w, requestID, http.StatusNotFound, "run_not_found", "run not found", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": run, "request_id": requestID})
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request, requestID string) {
	path := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/runs/"), "/cancel")
	if path == "" || strings.Contains(path, "/") {
		writeError(w, requestID, http.StatusBadRequest, "invalid_request", "run id is required", nil)
		return
	}
	inspector, ok := s.runs.(runtime.RunInspector)
	if !ok {
		writeError(w, requestID, http.StatusNotImplemented, "run_cancel_unavailable", "run cancellation is unavailable", nil)
		return
	}
	if err := inspector.Cancel(r.Context(), path); err != nil {
		writeError(w, requestID, http.StatusNotFound, "run_not_found", "run not found", nil)
		return
	}
	status := runtime.RunCanceled
	if run, err := inspector.Run(r.Context(), path); err == nil {
		status = run.Status
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"run_id": path, "status": status, "request_id": requestID})
}

func parsePage(r *http.Request) (int, int) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func decodeJSON(body interface{ Read([]byte) (int, error) }, value any) error {
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return fmt.Errorf("request body contains multiple JSON values")
	} else if err != io.EOF {
		return err
	}
	return nil
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
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Request-ID, Last-Event-ID")
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
