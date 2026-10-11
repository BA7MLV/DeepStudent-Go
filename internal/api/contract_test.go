package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/storage"
)

// blockingProvider makes cancellation deterministic: the run cannot complete
// before the test has sent POST /cancel.
type blockingProvider struct {
	started chan struct{}
	once    sync.Once
}

func (p *blockingProvider) Name() string { return "blocking-test" }

func (p *blockingProvider) Stream(ctx context.Context, _ runtime.ModelRequest, _ func(runtime.StreamEvent) error) error {
	p.once.Do(func() { close(p.started) })
	<-ctx.Done()
	return ctx.Err()
}

func newContractSQLiteStore(t *testing.T) *storage.SQLiteStore {
	t.Helper()
	store, err := storage.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "deepstudent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func decodeJSONBody(t *testing.T, response *httptest.ResponseRecorder, out any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), out); err != nil {
		t.Fatalf("decode JSON (%d): %v; body=%s", response.Code, err, response.Body.String())
	}
}

func doRequest(server http.Handler, method, path string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, body)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	return res
}

type acceptedRunContract struct {
	RunID     string `json:"run_id"`
	SessionID string `json:"session_id"`
	EventsURL string `json:"events_url"`
}

type sseContractEvent struct {
	ID   string
	Type string
	Data map[string]any
}

func parseSSEContract(t *testing.T, body string) []sseContractEvent {
	t.Helper()
	var events []sseContractEvent
	for _, block := range strings.Split(body, "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" || strings.HasPrefix(block, "retry:") {
			continue
		}
		var event sseContractEvent
		var data string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "id: "):
				event.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				event.Type = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		if event.ID == "" || event.Type == "" {
			t.Fatalf("malformed SSE block: %q", block)
		}
		if err := json.Unmarshal([]byte(data), &event.Data); err != nil {
			t.Fatalf("decode SSE data: %v; block=%q", err, block)
		}
		events = append(events, event)
	}
	return events
}

func TestHTTPContractSessionsMessagesRunSSEAndReplay(t *testing.T) {
	store := newContractSQLiteStore(t)
	runs := runtime.NewDeterministicRuntime(runtime.NewDeterministicProvider(), store, 1)
	t.Cleanup(runs.Close)
	server := NewServer(config.Defaults(), runs, store)

	created := doRequest(server, http.MethodPost, "/api/v1/sessions", strings.NewReader(`{"id":"contract-session","title":"Contract"}`), map[string]string{"Content-Type": "application/json", "X-Request-ID": "contract-create"})
	if created.Code != http.StatusCreated || created.Header().Get("X-Request-ID") != "contract-create" {
		t.Fatalf("create session = %d %s", created.Code, created.Body.String())
	}
	var createdBody struct{ Session runtime.Session `json:"session"` }
	decodeJSONBody(t, created, &createdBody)
	if createdBody.Session.ID != "contract-session" || createdBody.Session.Title != "Contract" {
		t.Fatalf("created session = %+v", createdBody.Session)
	}

	listed := doRequest(server, http.MethodGet, "/api/v1/sessions?limit=10", nil, nil)
	if listed.Code != http.StatusOK {
		t.Fatalf("list sessions = %d %s", listed.Code, listed.Body.String())
	}
	var listBody struct{ Sessions []runtime.Session `json:"sessions"` }
	decodeJSONBody(t, listed, &listBody)
	if len(listBody.Sessions) != 1 || listBody.Sessions[0].ID != "contract-session" {
		t.Fatalf("listed sessions = %+v", listBody.Sessions)
	}
	fetched := doRequest(server, http.MethodGet, "/api/v1/sessions/contract-session", nil, nil)
	if fetched.Code != http.StatusOK || !strings.Contains(fetched.Body.String(), `"contract-session"`) {
		t.Fatalf("get session = %d %s", fetched.Code, fetched.Body.String())
	}

	posted := doRequest(server, http.MethodPost, "/api/v1/sessions/contract-session/messages", strings.NewReader(`{"prompt":"hello contract","client_message_id":"client-contract-1"}`), map[string]string{"Content-Type": "application/json", "X-Request-ID": "contract-run"})
	if posted.Code != http.StatusAccepted {
		t.Fatalf("post message = %d %s", posted.Code, posted.Body.String())
	}
	var accepted acceptedRunContract
	decodeJSONBody(t, posted, &accepted)
	if accepted.RunID == "" || accepted.SessionID != "contract-session" || accepted.EventsURL == "" {
		t.Fatalf("accepted run = %+v", accepted)
	}

	stream := doRequest(server, http.MethodGet, accepted.EventsURL, nil, nil)
	if stream.Code != http.StatusOK || stream.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("SSE = %d %s %v", stream.Code, stream.Body.String(), stream.Header())
	}
	if !strings.Contains(stream.Body.String(), "retry: 3000") {
		t.Fatalf("SSE retry hint missing: %s", stream.Body.String())
	}
	events := parseSSEContract(t, stream.Body.String())
	if len(events) < 3 || events[0].Type != string(runtime.EventRunStarted) || events[len(events)-1].Type != string(runtime.EventRunCompleted) {
		t.Fatalf("SSE events = %+v", events)
	}

	replayReq := httptest.NewRequest(http.MethodGet, accepted.EventsURL, nil)
	replayReq.Header.Set("Last-Event-ID", events[0].ID)
	replay := httptest.NewRecorder()
	server.ServeHTTP(replay, replayReq)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d %s", replay.Code, replay.Body.String())
	}
	replayed := parseSSEContract(t, replay.Body.String())
	if len(replayed) != len(events)-1 || replayed[0].ID != events[1].ID || replayed[len(replayed)-1].Type != string(runtime.EventRunCompleted) {
		t.Fatalf("replayed events = %+v; original=%+v", replayed, events)
	}

	status := doRequest(server, http.MethodGet, "/api/v1/runs/"+url.PathEscape(accepted.RunID), nil, nil)
	if status.Code != http.StatusOK {
		t.Fatalf("run status = %d %s", status.Code, status.Body.String())
	}
	var statusBody struct{ Run runtime.RunRecord `json:"run"` }
	decodeJSONBody(t, status, &statusBody)
	if statusBody.Run.ID != accepted.RunID || statusBody.Run.Status != runtime.RunCompleted {
		t.Fatalf("run status body = %+v", statusBody.Run)
	}

	messages := doRequest(server, http.MethodGet, "/api/v1/sessions/contract-session/messages", nil, nil)
	if messages.Code != http.StatusOK {
		t.Fatalf("messages = %d %s", messages.Code, messages.Body.String())
	}
	var messagesBody struct{ Messages []runtime.Message `json:"messages"` }
	decodeJSONBody(t, messages, &messagesBody)
	if len(messagesBody.Messages) < 2 || messagesBody.Messages[0].Role != "user" || messagesBody.Messages[0].Content != "hello contract" {
		t.Fatalf("message timeline = %+v", messagesBody.Messages)
	}
	if messagesBody.Messages[len(messagesBody.Messages)-1].Role != "assistant" {
		t.Fatalf("assistant message missing: %+v", messagesBody.Messages)
	}
}

func TestHTTPContractIdempotentClientMessageID(t *testing.T) {
	store := newContractSQLiteStore(t)
	runs := runtime.NewDeterministicRuntime(runtime.NewDeterministicProvider(), store, 1)
	t.Cleanup(runs.Close)
	server := NewServer(config.Defaults(), runs, store)
	path := "/api/v1/sessions/idempotent/messages"
	body := `{"prompt":"same request","client_message_id":"client-idempotent-1"}`
	first := doRequest(server, http.MethodPost, path, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if first.Code != http.StatusAccepted {
		t.Fatalf("first request = %d %s", first.Code, first.Body.String())
	}
	var firstRun acceptedRunContract
	decodeJSONBody(t, first, &firstRun)
	second := doRequest(server, http.MethodPost, path, strings.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if second.Code != http.StatusAccepted {
		t.Fatalf("retry request = %d %s", second.Code, second.Body.String())
	}
	var secondRun acceptedRunContract
	decodeJSONBody(t, second, &secondRun)
	if secondRun.RunID != firstRun.RunID {
		t.Fatalf("retry started a different run: first=%+v second=%+v", firstRun, secondRun)
	}
	conflict := doRequest(server, http.MethodPost, path, strings.NewReader(`{"prompt":"different request","client_message_id":"client-idempotent-1"}`), map[string]string{"Content-Type": "application/json"})
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), `"message_id_conflict"`) {
		t.Fatalf("message id conflict = %d %s", conflict.Code, conflict.Body.String())
	}
}

func TestHTTPContractCancel(t *testing.T) {
	provider := &blockingProvider{started: make(chan struct{})}
	runs := runtime.NewDeterministicRuntime(provider, nil, 1)
	t.Cleanup(runs.Close)
	server := NewServer(config.Defaults(), runs)
	started := doRequest(server, http.MethodPost, "/api/v1/runs", strings.NewReader(`{"prompt":"cancel me"}`), map[string]string{"Content-Type": "application/json"})
	if started.Code != http.StatusAccepted {
		t.Fatalf("start = %d %s", started.Code, started.Body.String())
	}
	var accepted acceptedRunContract
	decodeJSONBody(t, started, &accepted)
	select {
	case <-provider.started:
	case <-time.After(time.Second):
		t.Fatal("provider did not start")
	}
	cancel := doRequest(server, http.MethodPost, "/api/v1/runs/"+accepted.RunID+"/cancel", nil, nil)
	if cancel.Code != http.StatusAccepted || !strings.Contains(cancel.Body.String(), accepted.RunID) {
		t.Fatalf("cancel = %d %s", cancel.Code, cancel.Body.String())
	}
	stream := doRequest(server, http.MethodGet, accepted.EventsURL, nil, nil)
	if stream.Code != http.StatusOK {
		t.Fatalf("cancel SSE = %d %s", stream.Code, stream.Body.String())
	}
	events := parseSSEContract(t, stream.Body.String())
	if len(events) == 0 || events[len(events)-1].Type != string(runtime.EventRunCanceled) {
		t.Fatalf("cancel events = %+v", events)
	}
}

func TestHTTPContractReadyCORSAndErrors(t *testing.T) {
	cfg := config.Defaults()
	cfg.Server.CORSAllowlist = []string{"https://allowed.example"}
	runs := runtime.NewDeterministicRuntime(runtime.NewDeterministicProvider(), nil, 1)
	t.Cleanup(runs.Close)
	server := NewServer(cfg, runs)
	server.SetReady(false)
	notReady := doRequest(server, http.MethodGet, "/readyz", nil, map[string]string{"X-Request-ID": "ready-contract"})
	if notReady.Code != http.StatusServiceUnavailable || notReady.Header().Get("X-Request-ID") != "ready-contract" || !strings.Contains(notReady.Body.String(), `"not_ready"`) {
		t.Fatalf("not ready = %d %s", notReady.Code, notReady.Body.String())
	}
	server.SetReady(true)
	ready := doRequest(server, http.MethodGet, "/readyz", nil, nil)
	if ready.Code != http.StatusOK || !strings.Contains(ready.Body.String(), `"status":"ready"`) {
		t.Fatalf("ready = %d %s", ready.Code, ready.Body.String())
	}
	options := doRequest(server, http.MethodOptions, "/api/v1/runs", nil, map[string]string{"Origin": "https://allowed.example"})
	if options.Code != http.StatusNoContent || options.Header().Get("Access-Control-Allow-Origin") != "https://allowed.example" || !strings.Contains(options.Header().Get("Access-Control-Allow-Headers"), "Last-Event-ID") {
		t.Fatalf("CORS preflight = %d %v", options.Code, options.Header())
	}
	forbidden := doRequest(server, http.MethodGet, "/healthz", nil, map[string]string{"Origin": "https://evil.example", "X-Request-ID": "cors-contract"})
	if forbidden.Code != http.StatusForbidden || forbidden.Header().Get("X-Request-ID") != "cors-contract" || !strings.Contains(forbidden.Body.String(), `"cors_denied"`) {
		t.Fatalf("forbidden origin = %d %s", forbidden.Code, forbidden.Body.String())
	}
	badJSON := doRequest(server, http.MethodPost, "/api/v1/runs", strings.NewReader("{"), map[string]string{"Content-Type": "application/json"})
	if badJSON.Code != http.StatusBadRequest || !strings.Contains(badJSON.Body.String(), `"invalid_json"`) {
		t.Fatalf("bad JSON = %d %s", badJSON.Code, badJSON.Body.String())
	}
	unknown := doRequest(server, http.MethodGet, "/api/v1/runs/missing/events", nil, nil)
	if unknown.Code != http.StatusNotFound || !strings.Contains(unknown.Body.String(), `"run_not_found"`) {
		t.Fatalf("unknown run = %d %s", unknown.Code, unknown.Body.String())
	}
}

func TestHTTPContractAttachmentUploadDownloadAndWorkspaceReference(t *testing.T) {
	db := newContractSQLiteStore(t)
	attachmentStore, err := storage.NewAttachmentStore(db, filepath.Join(t.TempDir(), "blobs"), attachments.Policy{MaxBytes: 1024, AllowedMIMEs: []string{"text/plain"}})
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(config.Defaults(), nil, db)
	server.SetAttachmentStore(attachmentStore)

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	partHeaders := make(textproto.MIMEHeader)
	partHeaders.Set("Content-Disposition", `form-data; name="file"; filename="contract.txt"`)
	partHeaders.Set("Content-Type", "text/plain")
	part, err := writer.CreatePart(partHeaders)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(part, "attachment contract"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	upload := doRequest(server, http.MethodPost, "/api/v1/attachments", &body, map[string]string{"Content-Type": writer.FormDataContentType()})
	if upload.Code != http.StatusCreated {
		t.Fatalf("attachment upload = %d %s", upload.Code, upload.Body.String())
	}
	var uploadBody struct{ Attachment attachments.Metadata `json:"attachment"` }
	decodeJSONBody(t, upload, &uploadBody)
	metadata := uploadBody.Attachment
	if metadata.SHA256 == "" || metadata.WorkspaceRef != "workspace://attachments/"+metadata.SHA256 || metadata.Size != int64(len("attachment contract")) || metadata.Filename != "contract.txt" {
		t.Fatalf("uploaded metadata = %+v", metadata)
	}

	metadataResponse := doRequest(server, http.MethodGet, "/api/v1/attachments/"+metadata.SHA256+"?metadata=1", nil, nil)
	if metadataResponse.Code != http.StatusOK {
		t.Fatalf("attachment metadata = %d %s", metadataResponse.Code, metadataResponse.Body.String())
	}
	var metadataBody struct{ Attachment attachments.Metadata `json:"attachment"` }
	decodeJSONBody(t, metadataResponse, &metadataBody)
	gotMetadata := metadataBody.Attachment
	if gotMetadata.WorkspaceRef != metadata.WorkspaceRef || gotMetadata.MIME != "text/plain" {
		t.Fatalf("metadata response = %+v", gotMetadata)
	}

	download := doRequest(server, http.MethodGet, "/api/v1/attachments/"+metadata.SHA256, nil, nil)
	if download.Code != http.StatusOK || download.Body.String() != "attachment contract" {
		t.Fatalf("attachment download = %d %q", download.Code, download.Body.String())
	}
	byReference := doRequest(server, http.MethodGet, "/api/v1/attachments/content?ref="+url.QueryEscape(metadata.WorkspaceRef), nil, nil)
	if byReference.Code != http.StatusOK || byReference.Body.String() != "attachment contract" {
		t.Fatalf("workspace reference download = %d %q", byReference.Code, byReference.Body.String())
	}
	metadataByReference := doRequest(server, http.MethodGet, "/api/v1/attachments?ref="+url.QueryEscape(metadata.WorkspaceRef), nil, nil)
	if metadataByReference.Code != http.StatusOK || !strings.Contains(metadataByReference.Body.String(), metadata.SHA256) {
		t.Fatalf("workspace reference metadata = %d %q", metadataByReference.Code, metadataByReference.Body.String())
	}
	invalid := doRequest(server, http.MethodGet, "/api/v1/attachments/workspace%3A%2F%2Fattachments%2Fbad", nil, nil)
	if invalid.Code < http.StatusBadRequest || invalid.Code >= http.StatusInternalServerError {
		t.Fatalf("invalid workspace reference = %d %s", invalid.Code, invalid.Body.String())
	}
}
