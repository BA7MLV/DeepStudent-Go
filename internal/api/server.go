// Package api exposes the versioned HTTP and SSE transport.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
)

const apiVersion = "v1"

type Server struct {
	cfg         config.Config
	runs        runtime.AgentRuntime
	store       runtime.SessionStore
	attachments AttachmentStore
	ready       atomic.Bool
	now         func() time.Time
}

// AttachmentStore is the HTTP-facing subset of storage.AttachmentStore. The
// interface keeps the API package independent from the SQLite implementation
// and makes the attachment contract straightforward to test with a fake store.
type AttachmentStore interface {
	Put(context.Context, attachments.Upload) (attachments.Metadata, error)
	Metadata(context.Context, string) (attachments.Metadata, error)
	Open(context.Context, string) (io.ReadCloser, attachments.Metadata, error)
	List(context.Context, int) ([]attachments.Metadata, error)
}

// NewServer creates an API server. Dependencies may include a
// runtime.SessionStore and/or an AttachmentStore. The variadic any form keeps
// the original two- and three-argument call sites source-compatible while
// allowing callers to wire the attachment HTTP API without a second server.
func NewServer(cfg config.Config, runs runtime.AgentRuntime, dependencies ...any) *Server {
	var store runtime.SessionStore
	var attachmentStore AttachmentStore
	for _, dependency := range dependencies {
		switch value := dependency.(type) {
		case runtime.SessionStore:
			store = value
		case AttachmentStore:
			attachmentStore = value
		}
	}
	s := &Server{cfg: cfg, runs: runs, store: store, attachments: attachmentStore, now: time.Now}
	s.ready.Store(runs != nil)
	return s
}

// SetAttachmentStore wires or replaces the attachment store. It is useful for
// embedders that build the runtime and API in separate initialization phases.
func (s *Server) SetAttachmentStore(store AttachmentStore) { s.attachments = store }

// AttachmentStore returns the currently configured HTTP attachment boundary.
func (s *Server) AttachmentStore() AttachmentStore { return s.attachments }

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
	case r.URL.Path == "/api/v1/attachments" || strings.HasPrefix(r.URL.Path, "/api/v1/attachments/"):
		s.attachmentRoute(w, r, requestID)
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
	// Liveness (/healthz) intentionally does not depend on the runtime. A
	// process with an unavailable runtime must remain distinguishable from a
	// ready process so supervisors do not route chat traffic too early.
	if !s.ready.Load() || s.runs == nil {
		writeError(w, requestID, http.StatusServiceUnavailable, "not_ready", "runtime is not ready", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "request_id": requestID})
}

const (
	// Multipart headers and field names are small, but a caller can still send
	// an arbitrarily large file. Keep a little room for multipart framing and
	// let BlobStore enforce the exact attachment policy.
	attachmentMultipartOverhead = 1 << 20
	attachmentMultipartMemory   = 8 << 20
)

// attachmentRoute implements the stable v1 attachment contract:
//
//   POST /api/v1/attachments              multipart/form-data (file field)
//   GET  /api/v1/attachments/<sha256>     content stream (or metadata=1)
//   GET  /api/v1/attachments?ref=<ref>    metadata for a workspace reference
//
// The explicit /metadata, /content and /download suffixes are accepted as
// convenience aliases for clients that prefer self-describing URLs. Every
// path and query reference is normalized through attachments.ParseWorkspaceRef
// before it reaches the storage layer.
func (s *Server) attachmentRoute(w http.ResponseWriter, r *http.Request, requestID string) {
	if s.attachments == nil {
		writeError(w, requestID, http.StatusServiceUnavailable, "storage_unavailable", "attachment storage is unavailable", nil)
		return
	}
	if r.URL.Path == "/api/v1/attachments" {
		switch r.Method {
		case http.MethodPost:
			s.uploadAttachment(w, r, requestID)
		case http.MethodGet, http.MethodHead:
			if strings.TrimSpace(r.URL.Query().Get("ref")) != "" || strings.TrimSpace(r.URL.Query().Get("sha256")) != "" {
				s.attachmentMetadata(w, r, requestID, "")
				return
			}
			s.listAttachments(w, r, requestID)
		default:
			writeError(w, requestID, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed", nil)
		}
		return
	}
	suffix := strings.TrimPrefix(r.URL.Path, "/api/v1/attachments/")
	suffix = strings.TrimSuffix(suffix, "/")
	if suffix == "" {
		writeError(w, requestID, http.StatusBadRequest, "invalid_reference", "attachment reference is required", nil)
		return
	}
	parts := strings.Split(suffix, "/")
	action := ""
	switch parts[0] {
	case "metadata", "content", "download":
		action = parts[0]
		parts = parts[1:]
	}
	if action == "" && len(parts) > 1 && parts[len(parts)-1] != "" {
		// Accept /<ref>/<operation> in addition to /<operation>/<ref>.
		last := parts[len(parts)-1]
		if last == "metadata" || last == "content" || last == "download" {
			action = last
			parts = parts[:len(parts)-1]
		}
	}
	ref := strings.Join(parts, "/")
	if strings.TrimSpace(r.URL.Query().Get("ref")) != "" {
		ref = r.URL.Query().Get("ref")
	}
	if strings.TrimSpace(r.URL.Query().Get("sha256")) != "" {
		ref = r.URL.Query().Get("sha256")
	}
	if action == "" {
		if r.URL.Query().Get("metadata") == "1" || r.URL.Query().Get("metadata") == "true" || acceptsJSON(r) {
			action = "metadata"
		} else {
			action = "content"
		}
	}
	switch action {
	case "metadata":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, requestID, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed", nil)
			return
		}
		s.attachmentMetadata(w, r, requestID, ref)
	case "content", "download":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, requestID, http.StatusMethodNotAllowed, "method_not_allowed", "method is not allowed", nil)
			return
		}
		download := action == "download" || r.URL.Query().Get("download") == "1" || r.URL.Query().Get("download") == "true"
		s.attachmentContent(w, r, requestID, ref, download)
	default:
		writeError(w, requestID, http.StatusNotFound, "not_found", "route not found", nil)
	}
}

func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request, requestID string) {
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "multipart/form-data" {
		writeError(w, requestID, http.StatusUnsupportedMediaType, "invalid_content_type", "attachment upload must use multipart/form-data", nil)
		return
	}
	maxBody := int64(64 << 20)
	if max := s.cfg.Storage.AttachmentMaxBytes; max > 0 {
		maxBody = max + attachmentMultipartOverhead
		if maxBody < max { // overflow guard for malformed configuration.
			maxBody = max
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := r.ParseMultipartForm(attachmentMultipartMemory); err != nil {
		// ParseMultipartForm may have spilled earlier parts to temporary files
		// before discovering a malformed or oversized part. Always remove those
		// files on the error path as well as after a successful upload.
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
		if strings.Contains(strings.ToLower(err.Error()), "request body too large") || strings.Contains(strings.ToLower(err.Error()), "multipart: message too large") {
			writeError(w, requestID, http.StatusRequestEntityTooLarge, "attachment_too_large", "attachment upload is too large", nil)
		} else {
			writeError(w, requestID, http.StatusBadRequest, "invalid_multipart", "request body must be valid multipart/form-data", nil)
		}
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	header, file, err := firstMultipartFile(r.MultipartForm)
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "missing_file", err.Error(), nil)
		return
	}
	defer file.Close()
	declaredMIME := strings.TrimSpace(header.Header.Get("Content-Type"))
	metadata, err := s.attachments.Put(r.Context(), attachments.Upload{Reader: file, MIME: declaredMIME, Filename: header.Filename})
	if err != nil {
		s.writeAttachmentError(w, requestID, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"attachment": metadata, "request_id": requestID})
}

func firstMultipartFile(form *multipart.Form) (*multipart.FileHeader, multipart.File, error) {
	if form == nil || len(form.File) == 0 {
		return nil, nil, errors.New("multipart file field is required")
	}
	// Keep the common names deterministic, then fall back to the first field.
	keys := []string{"file", "attachment", "upload"}
	var header *multipart.FileHeader
	for _, key := range keys {
		if values := form.File[key]; len(values) > 0 {
			header = values[0]
			break
		}
	}
	if header == nil {
		for _, values := range form.File {
			if len(values) > 0 {
				header = values[0]
				break
			}
		}
	}
	if header == nil {
		return nil, nil, errors.New("multipart file field is required")
	}
	file, err := header.Open()
	if err != nil {
		return nil, nil, fmt.Errorf("open multipart file: %w", err)
	}
	return header, file, nil
}

func (s *Server) attachmentMetadata(w http.ResponseWriter, r *http.Request, requestID, pathRef string) {
	ref := pathRef
	if strings.TrimSpace(ref) == "" {
		ref = strings.TrimSpace(r.URL.Query().Get("ref"))
	}
	if strings.TrimSpace(ref) == "" {
		ref = strings.TrimSpace(r.URL.Query().Get("sha256"))
	}
	canonical, err := canonicalAttachmentRef(ref)
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_reference", "attachment reference is invalid", nil)
		return
	}
	metadata, err := s.attachments.Metadata(r.Context(), canonical)
	if err != nil {
		s.writeAttachmentError(w, requestID, err)
		return
	}
	w.Header().Set("ETag", `"`+metadata.SHA256+`"`)
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"attachment": metadata, "request_id": requestID})
}

func (s *Server) listAttachments(w http.ResponseWriter, r *http.Request, requestID string) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 100
	}
	metadata, err := s.attachments.List(r.Context(), limit)
	if err != nil {
		s.writeAttachmentError(w, requestID, err)
		return
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"attachments": metadata, "request_id": requestID})
}

func (s *Server) attachmentContent(w http.ResponseWriter, r *http.Request, requestID, ref string, download bool) {
	canonical, err := canonicalAttachmentRef(ref)
	if err != nil {
		writeError(w, requestID, http.StatusBadRequest, "invalid_reference", "attachment reference is invalid", nil)
		return
	}
	file, metadata, err := s.attachments.Open(r.Context(), canonical)
	if err != nil {
		s.writeAttachmentError(w, requestID, err)
		return
	}
	defer file.Close()
	if _, ok := file.(io.ReadSeeker); !ok {
		writeError(w, requestID, http.StatusInternalServerError, "stream_unavailable", "attachment stream is unavailable", nil)
		return
	}
	w.Header().Set("Content-Type", metadata.MIME)
	w.Header().Set("Content-Length", strconv.FormatInt(metadata.Size, 10))
	w.Header().Set("ETag", `"`+metadata.SHA256+`"`)
	w.Header().Set("Accept-Ranges", "bytes")
	if metadata.Filename != "" {
		disposition := "inline"
		if download {
			disposition = "attachment"
		}
		w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": metadata.Filename}))
	}
	http.ServeContent(w, r, metadata.Filename, metadata.CreatedAt, file.(io.ReadSeeker))
}

func canonicalAttachmentRef(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", attachments.ErrInvalidReference
	}
	if digest, err := attachments.ParseWorkspaceRef(value); err == nil {
		return attachments.WorkspaceRef(digest)
	}
	// The path form intentionally accepts only a bare SHA-256 digest. Any
	// slash, dot segment or encoded separator remains invalid rather than being
	// interpreted as a filesystem path.
	if strings.ContainsAny(value, "/\\") || path.Clean(value) != value {
		return "", attachments.ErrInvalidReference
	}
	return attachments.WorkspaceRef(value)
}

func acceptsJSON(r *http.Request) bool {
	for _, value := range strings.Split(r.Header.Get("Accept"), ",") {
		value = strings.TrimSpace(strings.SplitN(value, ";", 2)[0])
		if value == "application/json" || value == "text/json" {
			return true
		}
	}
	return false
}

func (s *Server) writeAttachmentError(w http.ResponseWriter, requestID string, err error) {
	status, code, message := http.StatusInternalServerError, "attachment_failed", "could not process attachment"
	switch {
	case errors.Is(err, attachments.ErrInvalidReference), errors.Is(err, attachments.ErrInvalidSHA256):
		status, code, message = http.StatusBadRequest, "invalid_reference", "attachment reference is invalid"
	case errors.Is(err, attachments.ErrNotFound):
		status, code, message = http.StatusNotFound, "attachment_not_found", "attachment not found"
	case errors.Is(err, attachments.ErrTooLarge):
		status, code, message = http.StatusRequestEntityTooLarge, "attachment_too_large", "attachment exceeds the configured size limit"
	case errors.Is(err, attachments.ErrMIMEType):
		status, code, message = http.StatusUnsupportedMediaType, "attachment_mime_not_allowed", "attachment MIME type is not allowed"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		status, code, message = http.StatusRequestTimeout, "request_canceled", "attachment request was canceled"
	}
	writeError(w, requestID, status, code, message, nil)
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
		clientMessageID := strings.TrimSpace(input.ClientMessageID)
		if messageID != "" && clientMessageID != "" && messageID != clientMessageID {
			writeError(w, requestID, http.StatusBadRequest, "message_id_conflict", "message_id and client_message_id must match when both are provided", nil)
			return
		}
		if messageID == "" {
			messageID = clientMessageID
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
		stored, err := catalog.AppendMessage(r.Context(), message)
		if err != nil {
			if errors.Is(err, runtime.ErrMessageConflict) {
				writeError(w, requestID, http.StatusConflict, "message_id_conflict", "message id is already used for another message", nil)
				return
			}
			writeError(w, requestID, http.StatusInternalServerError, "message_persist_failed", "could not persist user message", nil)
			return
		}
		// AppendMessage is an atomic idempotency reservation in durable stores.
		// A concurrent retry can arrive after the first request's lookup but
		// before it starts the runtime; honor the run id returned by the store
		// instead of starting a second run.
		if messageID != "" && stored.RunID != "" && stored.RunID != requestedRunID {
			s.writeAcceptedRun(w, requestID, stored.RunID, input.SessionID, selection, input)
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
		Input:             input.Input,
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
	heartbeatInterval := s.cfg.Server.SSEHeartbeat
	if heartbeatInterval <= 0 {
		heartbeatInterval = 15 * time.Second
	}
	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			// SSE comments are ignored by clients but keep proxies and browser
			// connections alive while a provider is thinking.
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
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

func newID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(bytes[:])
}
