package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// SidecarRuntime is the Go transport adapter for a pi-agent sidecar. The
// sidecar owns the agent loop and tool execution; this type owns run lifetime,
// event replay, persistence and the AgentRuntime interface consumed by HTTP.
//
// Endpoint is the sidecar base URL. POST <endpoint>/run starts one stream and
// POST <endpoint>/run/<run_id>/cancel requests cancellation. The constructor
// does not start a process; process supervision is intentionally left to the
// embedding server (or a Docker/MyGo launcher).
type SidecarRuntime struct {
	endpoint      string
	client        *http.Client
	store         SessionStore
	cancelTimeout time.Duration
	retention     time.Duration

	mu   sync.RWMutex
	runs map[string]*sidecarRun
}

type SidecarRuntimeConfig struct {
	Endpoint      string
	Client        *http.Client
	Store         SessionStore
	CancelTimeout time.Duration
	Retention     time.Duration
}

// NewSidecarRuntime creates an adapter using http.DefaultClient. The HTTP
// client must not have a deadline shorter than the sidecar stream lifetime.
func NewSidecarRuntime(endpoint string, store SessionStore) (*SidecarRuntime, error) {
	return NewSidecarRuntimeWithConfig(SidecarRuntimeConfig{Endpoint: endpoint, Store: store})
}

func NewSidecarRuntimeWithConfig(cfg SidecarRuntimeConfig) (*SidecarRuntime, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(cfg.Endpoint), "/")
	if endpoint == "" {
		return nil, errors.New("sidecar endpoint is required")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("sidecar endpoint must be an absolute http(s) URL")
	}
	client := cfg.Client
	if client == nil {
		client = http.DefaultClient
	}
	cancelTimeout := cfg.CancelTimeout
	if cancelTimeout <= 0 {
		cancelTimeout = 2 * time.Second
	}
	retention := cfg.Retention
	if retention <= 0 {
		retention = 5 * time.Minute
	}
	return &SidecarRuntime{
		endpoint:      endpoint,
		client:        client,
		store:         cfg.Store,
		cancelTimeout: cancelTimeout,
		retention:     retention,
		runs:          make(map[string]*sidecarRun),
	}, nil
}

type sidecarRun struct {
	id        string
	sessionID string
	cancel    context.CancelFunc

	mu          sync.Mutex
	history     []StreamEvent
	sequences   []int64
	subscribers map[chan StreamEvent]struct{}
	closed      bool
	terminal    bool
	record      RunRecord
}

// Start creates a local run record and immediately opens the sidecar stream.
// Sidecar HTTP headers are expected to be returned promptly; event processing
// then continues in a goroutine so API POST callers receive 202 before the
// model response is complete.
func (r *SidecarRuntime) Start(ctx context.Context, request AgentRunRequest) (AgentRun, error) {
	if strings.TrimSpace(request.Prompt) == "" {
		return AgentRun{}, errors.New("prompt is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	runID := strings.TrimSpace(request.RunID)
	if runID == "" {
		runID = newID("run")
	}
	request.RunID = runID
	streamCtx, cancel := context.WithCancel(ctx)
	state := &sidecarRun{
		id: runID, sessionID: request.SessionID, cancel: cancel,
		subscribers: make(map[chan StreamEvent]struct{}),
		record: RunRecord{ID: runID, SessionID: request.SessionID, Provider: request.Provider, Model: request.Model, Status: RunQueued, CreatedAt: time.Now().UTC()},
	}
	first := make(chan StreamEvent, 32)
	state.subscribers[first] = struct{}{}
	r.mu.Lock()
	if _, exists := r.runs[runID]; exists {
		r.mu.Unlock()
		cancel()
		return AgentRun{}, fmt.Errorf("run %q already exists", runID)
	}
	r.runs[runID] = state
	r.mu.Unlock()
	if err := r.createRecords(request, state.record); err != nil {
		r.removeRun(runID, state)
		cancel()
		return AgentRun{}, err
	}

	body, err := json.Marshal(request)
	if err != nil {
		r.removeRun(runID, state)
		cancel()
		return AgentRun{}, fmt.Errorf("encode sidecar request: %w", err)
	}
	req, err := http.NewRequestWithContext(streamCtx, http.MethodPost, r.runURL(), bytes.NewReader(body))
	if err != nil {
		r.removeRun(runID, state)
		cancel()
		return AgentRun{}, fmt.Errorf("create sidecar request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(req)
	if err != nil {
		r.removeRun(runID, state)
		cancel()
		return AgentRun{}, fmt.Errorf("start sidecar run: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		defer response.Body.Close()
		message, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
		r.removeRun(runID, state)
		cancel()
		if len(bytes.TrimSpace(message)) == 0 {
			return AgentRun{}, fmt.Errorf("sidecar returned HTTP %d", response.StatusCode)
		}
		return AgentRun{}, fmt.Errorf("sidecar returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	state.mu.Lock()
	state.record.Status = RunRunning
	state.mu.Unlock()
	go r.consume(streamCtx, state, response.Body)
	return AgentRun{ID: runID, SessionID: request.SessionID, Events: first}, nil
}

func (r *SidecarRuntime) createRecords(request AgentRunRequest, record RunRecord) error {
	if r.store != nil && request.SessionID != "" {
		if err := r.store.CreateSession(context.Background(), request.SessionID); err != nil {
			return fmt.Errorf("create session: %w", err)
		}
	}
	if runs, ok := r.store.(RunStore); ok {
		if err := runs.CreateRun(context.Background(), record); err != nil {
			return fmt.Errorf("create run: %w", err)
		}
	}
	return nil
}

func (r *SidecarRuntime) runURL() string { return r.endpoint + "/run" }

// Health performs the bounded readiness probe used by serverapp. Liveness of
// the Go HTTP process remains independent from sidecar readiness.
func (r *SidecarRuntime) Health(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint+"/healthz", nil)
	if err != nil {
		return err
	}
	response, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("sidecar health returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (r *SidecarRuntime) cancelURL(runID string) string {
	return r.endpoint + "/run/" + url.PathEscape(runID) + "/cancel"
}

func (r *SidecarRuntime) removeRun(runID string, state *sidecarRun) {
	r.mu.Lock()
	if current, ok := r.runs[runID]; ok && current == state {
		delete(r.runs, runID)
	}
	r.mu.Unlock()
}

func (r *SidecarRuntime) consume(ctx context.Context, state *sidecarRun, body io.ReadCloser) {
	defer body.Close()
	err := ReadSidecarEnvelopes(body, func(envelope SidecarEnvelope) error {
		if r.isTerminal(state) {
			return errors.New("sidecar emitted an event after terminal event")
		}
		if envelope.RunID != state.id {
			return fmt.Errorf("sidecar run_id %q does not match requested run %q", envelope.RunID, state.id)
		}
		event, err := envelope.StreamEvent(time.Now().UTC())
		if err != nil {
			return err
		}
		if event.Done {
			state.mu.Lock()
			state.terminal = true
			state.mu.Unlock()
		}
		r.setStatusForEvent(state, event)
		if !r.emit(ctx, state, event) {
			return context.Canceled
		}
		return nil
	})
	if err != nil && !r.isTerminal(state) {
		r.finishTerminal(state, RunFailed, StreamEvent{ID: nextLocalEventID(state), RunID: state.id, Type: EventRunError, ErrorCode: "sidecar_stream_error", ErrorMessage: safeSidecarError(err), Done: true, CreatedAt: time.Now().UTC()})
	}
	if !r.isTerminal(state) {
		// EOF without a terminal record is a failed run, never a successful SSE
		// completion. This lets clients distinguish a crashed sidecar.
		r.finishTerminal(state, RunFailed, StreamEvent{ID: nextLocalEventID(state), RunID: state.id, Type: EventRunError, ErrorCode: "sidecar_stream_closed", ErrorMessage: "sidecar stream closed before a terminal event", Done: true, CreatedAt: time.Now().UTC()})
	}
	r.close(state)
}

func safeSidecarError(err error) string {
	if err == nil {
		return "sidecar stream failed"
	}
	message := strings.TrimSpace(err.Error())
	if message == "" {
		return "sidecar stream failed"
	}
	return message
}

func (r *SidecarRuntime) setStatusForEvent(state *sidecarRun, event StreamEvent) {
	switch event.Type {
	case EventRunStarted:
		r.setStatus(state, RunRunning)
	case EventRunCompleted:
		r.setStatus(state, RunCompleted)
	case EventRunCanceled:
		r.setStatus(state, RunCanceled)
	case EventRunError:
		r.setStatus(state, RunFailed)
	}
}

func (r *SidecarRuntime) setStatus(state *sidecarRun, status RunStatus) {
	state.mu.Lock()
	state.record.Status = status
	if status == RunCompleted || status == RunFailed || status == RunCanceled {
		finished := time.Now().UTC()
		state.record.FinishedAt = &finished
	}
	record := state.record
	state.mu.Unlock()
	if runs, ok := r.store.(RunStore); ok && record.FinishedAt != nil {
		_ = runs.FinishRun(context.Background(), record.ID, status, *record.FinishedAt)
	}
}

func (r *SidecarRuntime) emit(ctx context.Context, state *sidecarRun, event StreamEvent) bool {
	if ctx != nil && !event.Done {
		select {
		case <-ctx.Done():
			return false
		default:
		}
	}
	if event.RunID == "" {
		event.RunID = state.id
	}
	var sequence int64
	if r.store != nil && state.sessionID != "" {
		payload, _ := json.Marshal(event)
		persisted, err := r.store.AppendEvent(context.Background(), SessionEvent{SessionID: state.sessionID, RunID: state.id, Type: string(event.Type), Payload: payload, CreatedAt: event.CreatedAt})
		if err == nil {
			sequence = persisted.Sequence
		}
		if event.Type == EventTextDelta {
			content := event.Text
			if content == "" {
				content = event.Delta
			}
			if catalog, ok := r.store.(SessionCatalog); ok && content != "" {
				_, _ = catalog.AppendMessage(context.Background(), Message{SessionID: state.sessionID, RunID: state.id, Role: "assistant", Content: content, CreatedAt: event.CreatedAt})
			}
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed {
		return false
	}
	state.history = append(state.history, event)
	state.sequences = append(state.sequences, sequence)
	for subscriber := range state.subscribers {
		select {
		case subscriber <- event:
		default:
		}
	}
	return true
}

func (r *SidecarRuntime) isTerminal(state *sidecarRun) bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.terminal
}

func (r *SidecarRuntime) close(state *sidecarRun) {
	state.mu.Lock()
	if state.closed {
		state.mu.Unlock()
		return
	}
	state.closed = true
	for subscriber := range state.subscribers {
		close(subscriber)
	}
	state.subscribers = nil
	state.mu.Unlock()
	time.AfterFunc(r.retention, func() { r.removeRun(state.id, state) })
}

// Run implements RunInspector for the HTTP status endpoint.
func (r *SidecarRuntime) Run(ctx context.Context, runID string) (RunRecord, error) {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if ok {
		state.mu.Lock()
		record := state.record
		state.mu.Unlock()
		return record, nil
	}
	if reader, ok := r.store.(RunReader); ok {
		return reader.Run(ctx, runID)
	}
	return RunRecord{}, fmt.Errorf("run %q not found", runID)
}

func (r *SidecarRuntime) Subscribe(ctx context.Context, runID string) (<-chan StreamEvent, error) {
	return r.SubscribeFrom(ctx, runID, "")
}

// SubscribeFrom replays buffered sidecar events after Last-Event-ID and then
// follows the live stream. Sidecar sequence ids are opaque strings in the SSE
// layer, but numeric ids are also accepted for compatibility with persisted
// session sequence cursors.
func (r *SidecarRuntime) SubscribeFrom(ctx context.Context, runID, lastEventID string) (<-chan StreamEvent, error) {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if !ok {
		events, err := r.replayPersisted(ctx, runID, strings.TrimSpace(lastEventID))
		if err != nil {
			return nil, err
		}
		channel := make(chan StreamEvent, len(events))
		for _, event := range events {
			channel <- event
		}
		close(channel)
		return channel, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	lastEventID = strings.TrimSpace(lastEventID)
	lastSequence, hasSequence := parseEventSequence(lastEventID)
	state.mu.Lock()
	channel := make(chan StreamEvent, len(state.history)+16)
	replay := lastEventID == ""
	for index, event := range state.history {
		if replay {
			channel <- event
			continue
		}
		if event.ID == lastEventID || (hasSequence && index < len(state.sequences) && state.sequences[index] > lastSequence) {
			if hasSequence {
				channel <- event
			}
			replay = true
		}
	}
	closed := state.closed
	if closed {
		close(channel)
	} else {
		state.subscribers[channel] = struct{}{}
	}
	state.mu.Unlock()
	if !closed {
		go func() {
			<-ctx.Done()
			state.mu.Lock()
			if _, exists := state.subscribers[channel]; exists {
				delete(state.subscribers, channel)
				close(channel)
			}
			state.mu.Unlock()
		}()
	}
	return channel, nil
}

func (r *SidecarRuntime) replayPersisted(ctx context.Context, runID, lastEventID string) ([]StreamEvent, error) {
	reader, ok := r.store.(RunReader)
	if !ok {
		return nil, fmt.Errorf("run %q not found", runID)
	}
	run, err := reader.Run(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.SessionID == "" {
		return nil, fmt.Errorf("run %q has no session", runID)
	}
	events, err := r.store.Events(ctx, run.SessionID, 0)
	if err != nil {
		return nil, err
	}
	lastSequence, hasSequence := parseEventSequence(lastEventID)
	if lastEventID != "" && !hasSequence {
		for _, persisted := range events {
			if persisted.RunID != runID {
				continue
			}
			var event StreamEvent
			if json.Unmarshal(persisted.Payload, &event) == nil && event.ID == lastEventID {
				lastSequence = persisted.Sequence
				hasSequence = true
				break
			}
		}
		if !hasSequence {
			return []StreamEvent{}, nil
		}
	}
	result := make([]StreamEvent, 0, len(events))
	for _, persisted := range events {
		if persisted.RunID != runID || (lastEventID != "" && persisted.Sequence <= lastSequence) {
			continue
		}
		var event StreamEvent
		if err := json.Unmarshal(persisted.Payload, &event); err != nil {
			continue
		}
		event.RunID = runID
		if event.Type == "" {
			event.Type = StreamEventType(persisted.Type)
		}
		if event.CreatedAt.IsZero() {
			event.CreatedAt = persisted.CreatedAt
		}
		result = append(result, event)
	}
	return result, nil
}

// Cancel asks the sidecar to stop a run. A healthy sidecar should emit one
// run.canceled record on the original stream. If the endpoint is unavailable,
// a local cancellation event is emitted after the bounded cancel request so
// clients never observe a clean EOF without a terminal event.
func (r *SidecarRuntime) Cancel(_ context.Context, runID string) error {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if !ok {
		if _, err := r.Run(context.Background(), runID); err != nil {
			return err
		}
		return nil
	}
	if r.isTerminal(state) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.cancelTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cancelURL(runID), nil)
	if err == nil {
		response, requestErr := r.client.Do(req)
		if requestErr == nil {
			_ = response.Body.Close()
			if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
				err = fmt.Errorf("sidecar cancel returned HTTP %d", response.StatusCode)
			} else {
				err = nil
			}
		} else {
			err = requestErr
		}
	}
	if err != nil {
		// The fallback is terminal and closes the local stream; consume will see
		// terminal=true and will not append a duplicate stream error.
		r.forceCancel(state, "run canceled")
	} else {
		// A sidecar normally emits run.canceled on the original stream. Keep a
		// bounded fallback in case an implementation acknowledges the cancel
		// request but drops the stream before writing its terminal record.
		go func() {
			timer := time.NewTimer(r.cancelTimeout)
			defer timer.Stop()
			<-timer.C
			if !r.isTerminal(state) {
				r.forceCancel(state, "run canceled")
			}
		}()
	}
	return err
}

func (r *SidecarRuntime) forceCancel(state *sidecarRun, message string) {
	state.mu.Lock()
	if state.terminal {
		state.mu.Unlock()
		return
	}
	state.terminal = true
	state.mu.Unlock()
	r.setStatus(state, RunCanceled)
	r.emit(context.Background(), state, StreamEvent{ID: nextLocalEventID(state), RunID: state.id, Type: EventRunCanceled, ErrorCode: "canceled", ErrorMessage: message, Done: true, CreatedAt: time.Now().UTC()})
	r.close(state)
	state.cancel()
}

func (r *SidecarRuntime) finishTerminal(state *sidecarRun, status RunStatus, event StreamEvent) {
	state.mu.Lock()
	if state.terminal {
		state.mu.Unlock()
		return
	}
	state.terminal = true
	state.mu.Unlock()
	r.setStatus(state, status)
	r.emit(context.Background(), state, event)
}

func nextLocalEventID(state *sidecarRun) string {
	state.mu.Lock()
	defer state.mu.Unlock()
	return fmt.Sprintf("local-%d", len(state.history)+1)
}

// Close cancels active sidecar streams and closes their subscribers. It does
// not terminate an external sidecar process; the process owner remains the
// server launcher or container supervisor.
func (r *SidecarRuntime) Close() {
	r.mu.RLock()
	states := make([]*sidecarRun, 0, len(r.runs))
	for _, state := range r.runs {
		states = append(states, state)
	}
	r.mu.RUnlock()
	for _, state := range states {
		if !r.isTerminal(state) {
			r.forceCancel(state, "runtime closed")
			continue
		}
		state.cancel()
		r.close(state)
	}
}
