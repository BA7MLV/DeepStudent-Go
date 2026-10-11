package runtime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

type appendFailureStore struct {
	*MemorySessionStore
	runs map[string]RunRecord
}

func newAppendFailureStore() *appendFailureStore {
	return &appendFailureStore{MemorySessionStore: NewMemorySessionStore(), runs: make(map[string]RunRecord)}
}

func (s *appendFailureStore) AppendEvent(context.Context, SessionEvent) (SessionEvent, error) {
	return SessionEvent{}, errors.New("disk full")
}

func (s *appendFailureStore) CreateRun(_ context.Context, run RunRecord) error {
	s.runs[run.ID] = run
	return nil
}

func (s *appendFailureStore) FinishRun(_ context.Context, runID string, status RunStatus, finishedAt time.Time) error {
	run, ok := s.runs[runID]
	if !ok {
		return fmt.Errorf("run %q not found", runID)
	}
	run.Status, run.FinishedAt = status, &finishedAt
	s.runs[runID] = run
	return nil
}

type blockingProvider struct{}

func (blockingProvider) Name() string { return "blocking" }

func (blockingProvider) Stream(ctx context.Context, _ ModelRequest, _ func(StreamEvent) error) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestDeterministicRuntimeEmitsTerminalEvents(t *testing.T) {
	store := NewMemorySessionStore()
	runtime := NewDeterministicRuntime(NewDeterministicProvider(), store, 1)
	run, err := runtime.Start(context.Background(), AgentRunRequest{SessionID: "s1", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	var events []StreamEvent
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				if len(events) < 3 || events[0].Type != EventRunStarted || events[len(events)-1].Type != EventRunCompleted {
					t.Fatalf("unexpected events: %+v", events)
				}
				return
			}
			events = append(events, event)
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for stream")
		}
	}
}

func TestDeterministicRuntimeTimeoutReleasesRun(t *testing.T) {
	runtime := NewDeterministicRuntimeWithTimeout(blockingProvider{}, nil, 1, 10*time.Millisecond)
	run, err := runtime.Start(context.Background(), AgentRunRequest{Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.After(time.Second)
	var events []StreamEvent
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				if len(events) == 0 || events[len(events)-1].Type != EventRunError {
					t.Fatalf("expected terminal timeout error, got %+v", events)
				}
				return
			}
			events = append(events, event)
		case <-deadline:
			t.Fatal("timed out waiting for run to close")
		}
	}
}

func TestDeterministicRuntimeQueuedRunHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runtime := NewDeterministicRuntime(nil, nil, 1)
	run, err := runtime.Start(ctx, AgentRunRequest{Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event, ok := <-run.Events:
		if !ok || event.Type != EventRunCanceled || !event.Done {
			t.Fatalf("canceled run terminal event = %+v, open=%v", event, ok)
		}
		if _, ok := <-run.Events; ok {
			t.Fatal("canceled run emitted more than one terminal event")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for canceled run")
	}
	if errors.Is(ctx.Err(), context.Canceled) == false {
		t.Fatal("test context was not canceled")
	}
}

func TestDeterministicRuntimePersistenceFailureIsTerminal(t *testing.T) {
	store := newAppendFailureStore()
	runtime := NewDeterministicRuntime(NewDeterministicProvider(), store, 1)
	run, err := runtime.Start(context.Background(), AgentRunRequest{RunID: "persist-failure", SessionID: "s1", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event, ok := <-run.Events:
		if !ok || event.Type != EventRunError || event.ErrorCode != "event_persistence" || !event.Done {
			t.Fatalf("persistence failure event = %+v, open=%v", event, ok)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for persistence failure")
	}
	if event, ok := <-run.Events; ok {
		t.Fatalf("unexpected event after persistence failure: %+v", event)
	}
	if got := store.runs[run.ID].Status; got != RunFailed {
		t.Fatalf("run status = %q, want %q", got, RunFailed)
	}
}
