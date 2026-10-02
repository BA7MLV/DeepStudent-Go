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
	mu          sync.Mutex
	history     []StreamEvent
	subscribers map[chan StreamEvent]struct{}
	closed      bool
}

// DeterministicRuntime wires a provider to a small in-memory event broker.
// A durable SessionStore can be supplied; every emitted event is appended
// before it is broadcast to subscribers.
type DeterministicRuntime struct {
	provider ModelProvider
	store    SessionStore
	sem      chan struct{}
	mu       sync.RWMutex
	runs     map[string]*deterministicRun
}

func NewDeterministicRuntime(provider ModelProvider, store SessionStore, maxConcurrency int) *DeterministicRuntime {
	if provider == nil {
		provider = NewDeterministicProvider()
	}
	if maxConcurrency < 1 {
		maxConcurrency = 1
	}
	return &DeterministicRuntime{
		provider: provider,
		store:    store,
		sem:      make(chan struct{}, maxConcurrency),
		runs:     make(map[string]*deterministicRun),
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
	state := &deterministicRun{id: runID, sessionID: request.SessionID, subscribers: make(map[chan StreamEvent]struct{})}
	first := make(chan StreamEvent, 16)
	state.subscribers[first] = struct{}{}
	r.mu.Lock()
	if _, exists := r.runs[runID]; exists {
		r.mu.Unlock()
		return AgentRun{}, fmt.Errorf("run %q already exists", runID)
	}
	r.runs[runID] = state
	r.mu.Unlock()
	go r.execute(ctx, state, request)
	return AgentRun{ID: runID, SessionID: request.SessionID, Events: first}, nil
}

func (r *DeterministicRuntime) Subscribe(ctx context.Context, runID string) (<-chan StreamEvent, error) {
	r.mu.RLock()
	state, ok := r.runs[runID]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("run %q not found", runID)
	}
	state.mu.Lock()
	channel := make(chan StreamEvent, len(state.history)+16)
	for _, event := range state.history {
		channel <- event
	}
	if state.closed {
		close(channel)
	} else {
		state.subscribers[channel] = struct{}{}
	}
	state.mu.Unlock()
	return channel, nil
}

func (r *DeterministicRuntime) execute(ctx context.Context, state *deterministicRun, request AgentRunRequest) {
	r.sem <- struct{}{}
	defer func() { <-r.sem }()
	defer r.close(state)
	started := StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunStarted, CreatedAt: time.Now().UTC()}
	if !r.emit(ctx, state, started) {
		return
	}
	err := r.provider.Stream(ctx, ModelRequest{Model: request.Model, Prompt: request.Prompt, MaxTokens: request.MaxTokens}, func(event StreamEvent) error {
		event.ID = newID("evt")
		event.RunID = state.id
		event.CreatedAt = time.Now().UTC()
		if !r.emit(ctx, state, event) {
			return ctx.Err()
		}
		return nil
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		r.emit(ctx, state, StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunError, ErrorCode: "provider_error", ErrorMessage: "model provider failed", Done: true, CreatedAt: time.Now().UTC()})
	} else if err == nil {
		r.emit(ctx, state, StreamEvent{ID: newID("evt"), RunID: state.id, Type: EventRunCompleted, Done: true, CreatedAt: time.Now().UTC()})
	}
}

func (r *DeterministicRuntime) emit(ctx context.Context, state *deterministicRun, event StreamEvent) bool {
	if ctx != nil {
		select {
		case <-ctx.Done():
			return false
		default:
		}
	}
	if r.store != nil && state.sessionID != "" {
		payload, _ := json.Marshal(event)
		_, _ = r.store.AppendEvent(context.Background(), SessionEvent{SessionID: state.sessionID, RunID: state.id, Type: string(event.Type), Payload: payload, CreatedAt: event.CreatedAt})
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
}

func newID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(bytes[:])
}
