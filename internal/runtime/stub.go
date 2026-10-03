package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// DeterministicProvider is a local provider that never accesses the network or
// reads secrets. It is useful for smoke tests and for the frontend mock-to-SSE
// migration path.
type DeterministicProvider struct{}

func NewDeterministicProvider() DeterministicProvider { return DeterministicProvider{} }
func (DeterministicProvider) Name() string            { return "deterministic" }

func (DeterministicProvider) Stream(ctx context.Context, request ModelRequest, emit func(StreamEvent) error) error {
	text := strings.TrimSpace(request.Prompt)
	if text == "" && len(request.Messages) > 0 {
		text = request.Messages[len(request.Messages)-1].Content
	}
	if text == "" {
		text = "ready"
	}
	return emit(StreamEvent{Type: EventTextDelta, Delta: "deterministic: " + text, Text: "deterministic: " + text})
}

type deterministicRun struct {
	id          string
	sessionID   string
	cancel      context.CancelFunc
	mu          sync.Mutex
	history     []StreamEvent
	subscribers map[chan StreamEvent]struct{}
	closed      bool
	record      RunRecord
}

// DeterministicRuntime wires a provider to a small in-memory event broker.
// A durable SessionStore can be supplied; every emitted event is appended
// before it is broadcast to subscribers.
type DeterministicRuntime struct {
	provider  ModelProvider
	store     SessionStore
	sem       chan struct{}
	timeout   time.Duration
	retention time.Duration
	mu        sync.RWMutex
	runs      map[string]*deterministicRun
}

func NewDeterministicRuntime(provider ModelProvider, store SessionStore, maxConcurrency int) *DeterministicRuntime {
	return NewDeterministicRuntimeWithTimeout(provider, store, maxConcurrency, 0)
}

// NewDeterministicRuntimeWithTimeout is the production constructor. A positive
// timeout bounds provider and persistence work for each run; zero preserves the
// unbounded behavior used by low-level tests and callers that manage context
// cancellation themselves.
func NewDeterministicRuntimeWithTimeout(provider ModelProvider, store SessionStore, maxConcurrency int, timeout time.Duration) *DeterministicRuntime {
	if provider == nil {
		provider = NewDeterministicProvider()
	}
	if maxConcurrency < 1 {
		maxConcurrency = 1
	}
	return &DeterministicRuntime{
		provider:  provider,
		store:     store,
		sem:       make(chan struct{}, maxConcurrency),
		timeout:   timeout,
		// Keep completed runs briefly so a client can attach after POST returns,
		// then release the history and channels instead of retaining every run.
		retention: 5 * time.Minute,
		runs:      make(map[string]*deterministicRun),
	}
}

func (r *DeterministicRuntime) Start(ctx context.Context, request AgentRunRequest) (AgentRun, error) {
	if strings.TrimSpace(request.Prompt) == "" {
		return AgentRun{}, errors.New("prompt is required")
	}
	runID := request.RunID
	if runID == "" {
		runID = newID("run")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var runCtx context.Context
	var cancel context.CancelFunc
	if r.timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, r.timeout)
	} else {
		runCtx, cancel = context.WithCancel(ctx)
	}
	state := &deterministicRun{id: runID, sessionID: request.SessionID, cancel: cancel, subscribers: make(map[chan StreamEvent]struct{})}
	state.record = RunRecord{ID: runID, SessionID: request.SessionID, Provider: request.Provider, Model: request.Model, Status: RunQueued, CreatedAt: time.Now().UTC()}
	first := make(chan StreamEvent, 16)
	state.subscribers[first] = struct{}{}
	r.mu.Lock()
	if _, exists := r.runs[runID]; exists {
		r.mu.Unlock()
		cancel()
		return AgentRun{}, fmt.Errorf("run %q already exists", runID)
	}
	r.runs[runID] = state
	r.mu.Unlock()
	if r.store != nil && request.SessionID != "" {
		if err := r.store.CreateSession(context.Background(), request.SessionID); err != nil {
			cancel()
			r.mu.Lock()
			delete(r.runs, runID)
			r.mu.Unlock()
			return AgentRun{}, fmt.Errorf("create session: %w", err)
		}
	}
	if catalog, ok := r.store.(RunStore); ok {
		if err := catalog.CreateRun(context.Background(), state.record); err != nil {
			cancel()
			r.mu.Lock()
			delete(r.runs, runID)
			r.mu.Unlock()
			return AgentRun{}, fmt.Errorf("create run: %w", err)
		}
	}
	go r.execute(runCtx, state, request)
	return AgentRun{ID: runID, SessionID: request.SessionID, Events: first}, nil
}

// Run returns the latest in-memory status for a run.
func (r *DeterministicRuntime) Run(_ context.Context, runID string) (RunRecord, error) {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if !ok {
		return RunRecord{}, fmt.Errorf("run %q not found", runID)
	}
	state.mu.Lock()
	record := state.record
	state.mu.Unlock()
	return record, nil
}

// Cancel requests cancellation. A terminal run is idempotently left alone.
func (r *DeterministicRuntime) Cancel(_ context.Context, runID string) error {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if !ok {
		return fmt.Errorf("run %q not found", runID)
	}
	state.cancel()
	return nil
}

func (r *DeterministicRuntime) Subscribe(ctx context.Context, runID string) (<-chan StreamEvent, error) {
	return r.SubscribeFrom(ctx, runID, "")
}

// SubscribeFrom replays events after lastEventID before following live events.
// The replay window is intentionally bounded by the in-memory retention policy.
func (r *DeterministicRuntime) SubscribeFrom(ctx context.Context, runID, lastEventID string) (<-chan StreamEvent, error) {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("run %q not found", runID)
	}
	state.mu.Lock()
	channel := make(chan StreamEvent, len(state.history)+16)
	replay := lastEventID == ""
	for _, event := range state.history {
		if replay {
			channel <- event
		} else if event.ID == lastEventID {
			replay = true
	}
	}
	if state.closed {
		close(channel)
	} else {
		state.subscribers[channel] = struct{}{}
	}
	state.mu.Unlock()
	if ctx != nil {
		go func() {
			<-ctx.Done()
			state.mu.Lock()
			if _, ok := state.subscribers[channel]; ok {
				delete(state.subscribers, channel)
				close(channel)
			}
			state.mu.Unlock()
		}()
	}
	return channel, nil
}

func (r *DeterministicRuntime) execute(ctx context.Context, state *deterministicRun, request AgentRunRequest) {
	defer state.cancel()
	defer r.close(state)
	if ctx.Err() != nil {
		r.setStatus(state, RunCanceled)
		return
	}
	select {
	case r.sem <- struct{}{}:
		r.setStatus(state, RunRunning)
	case <-ctx.Done():
		r.setStatus(state, RunCanceled)
		return
	}
	defer func() { <-r.sem }()
	started := StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunStarted, CreatedAt: time.Now().UTC()}
	if !r.emit(ctx, state, started) {
		return
	}
	capabilities := request.InputCapabilities
	if capabilities == nil {
		capabilities = request.Input
	}
	err := r.provider.Stream(ctx, ModelRequest{
		Provider:          request.Provider,
		Model:             request.Model,
		ReasoningEffort:   request.ReasoningEffort,
		Prompt:            request.Prompt,
		MaxTokens:         request.MaxTokens,
		InputCapabilities: append([]string(nil), capabilities...),
		Input:             append([]string(nil), capabilities...),
	}, func(event StreamEvent) error {
		event.ID = newID("evt")
		event.RunID = state.id
		event.CreatedAt = time.Now().UTC()
		if !r.emit(ctx, state, event) {
			return ctx.Err()
		}
		return nil
	})
	if err == nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	if err != nil && errors.Is(err, context.Canceled) {
		r.emit(context.Background(), state, StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunCanceled, ErrorCode: "canceled", ErrorMessage: "run canceled", Done: true, CreatedAt: time.Now().UTC()})
		r.setStatus(state, RunCanceled)
	} else if err != nil {
		errorCode := "provider_error"
		errorMessage := "model provider failed"
		if errors.Is(err, context.DeadlineExceeded) {
			errorCode = "timeout"
			errorMessage = "run timed out"
		}
		r.emit(context.Background(), state, StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunError, ErrorCode: errorCode, ErrorMessage: errorMessage, Done: true, CreatedAt: time.Now().UTC()})
		r.setStatus(state, RunFailed)
	} else if err == nil {
		r.emit(ctx, state, StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunCompleted, Done: true, CreatedAt: time.Now().UTC()})
		r.setStatus(state, RunCompleted)
	}
}

func (r *DeterministicRuntime) setStatus(state *deterministicRun, status RunStatus) {
	state.mu.Lock()
	state.record.Status = status
	if status == RunCompleted || status == RunFailed || status == RunCanceled {
		now := time.Now().UTC()
		state.record.FinishedAt = &now
	}
	record := state.record
	state.mu.Unlock()
	if store, ok := r.store.(RunStore); ok && record.FinishedAt != nil {
		_ = store.FinishRun(context.Background(), record.ID, status, *record.FinishedAt)
	}
}

func (r *DeterministicRuntime) emit(ctx context.Context, state *deterministicRun, event StreamEvent) bool {
	// Terminal events still need to reach connected clients when a provider
	// returns a deadline error; non-terminal events stop promptly on cancel.
	if ctx != nil && !event.Done {
		select {
		case <-ctx.Done():
			return false
		default:
		}
	}
	if r.store != nil && state.sessionID != "" {
		payload, _ := json.Marshal(event)
		_, _ = r.store.AppendEvent(ctx, SessionEvent{SessionID: state.sessionID, RunID: state.id, Type: string(event.Type), Payload: payload, CreatedAt: event.CreatedAt})
		if event.Type == EventTextDelta {
			content := event.Text
			if content == "" {
				content = event.Delta
			}
			if catalog, ok := r.store.(SessionCatalog); ok && content != "" {
				_, _ = catalog.AppendMessage(ctx, Message{SessionID: state.sessionID, RunID: state.id, Role: "assistant", Content: content, CreatedAt: event.CreatedAt})
			}
		}
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closed {
		return false
	}
	state.history = append(state.history, event)
	for subscriber := range state.subscribers {
		select {
		case subscriber <- event:
		default:
		}
	}
	return true
}

func (r *DeterministicRuntime) close(state *deterministicRun) {
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
	// Retain a completed run just long enough for a client to subscribe after
	// the asynchronous POST response, then release its event history.
	time.AfterFunc(r.retention, func() {
		r.mu.Lock()
		if current, ok := r.runs[state.id]; ok && current == state {
			delete(r.runs, state.id)
		}
		r.mu.Unlock()
	})
}

// Close cancels active runs and releases their subscribers. It is safe to call
// during server shutdown before the backing store is closed.
func (r *DeterministicRuntime) Close() {
	r.mu.RLock()
	states := make([]*deterministicRun, 0, len(r.runs))
	for _, state := range r.runs {
		states = append(states, state)
	}
	r.mu.RUnlock()
	for _, state := range states {
		state.cancel()
		r.close(state)
	}
}

func newID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(bytes[:])
}
