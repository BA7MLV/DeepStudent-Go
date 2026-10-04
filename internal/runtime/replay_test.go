package runtime

import (
	"context"
	"strconv"
	"testing"
	"time"
)

// replayStore models the durable interfaces used by DeterministicRuntime. It
// intentionally keeps the event log in a shared MemorySessionStore so a
// second runtime can exercise the restart path without sharing in-memory run
// state.
type replayStore struct {
	*MemorySessionStore
	runs map[string]RunRecord
}

func newReplayStore() *replayStore {
	return &replayStore{MemorySessionStore: NewMemorySessionStore(), runs: make(map[string]RunRecord)}
}

func (s *replayStore) CreateRun(_ context.Context, run RunRecord) error {
	s.runs[run.ID] = run
	return nil
}

func (s *replayStore) FinishRun(_ context.Context, runID string, status RunStatus, finishedAt time.Time) error {
	run := s.runs[runID]
	run.Status = status
	run.FinishedAt = &finishedAt
	s.runs[runID] = run
	return nil
}

func (s *replayStore) Run(_ context.Context, runID string) (RunRecord, error) {
	run, ok := s.runs[runID]
	if !ok {
		return RunRecord{}, context.Canceled
	}
	return run, nil
}

func collectReplayTestEvents(t *testing.T, events <-chan StreamEvent) []StreamEvent {
	t.Helper()
	result := make([]StreamEvent, 0)
	deadline := time.After(time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return result
			}
			result = append(result, event)
		case <-deadline:
			t.Fatal("timed out waiting for replay events")
		}
	}
}

func TestDeterministicRuntimeReplaysPersistedEventsAfterRestart(t *testing.T) {
	store := newReplayStore()
	first := NewDeterministicRuntime(NewDeterministicProvider(), store, 1)
	run, err := first.Start(context.Background(), AgentRunRequest{SessionID: "session-replay", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	original := collectReplayTestEvents(t, run.Events)
	if len(original) < 3 {
		t.Fatalf("expected start, delta, and terminal events, got %d", len(original))
	}
	first.Close()

	second := NewDeterministicRuntime(NewDeterministicProvider(), store, 1)
	replayed, err := second.SubscribeFrom(context.Background(), run.ID, original[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	got := collectReplayTestEvents(t, replayed)
	if len(got) != len(original)-1 || got[0].ID != original[1].ID || got[len(got)-1].Type != EventRunCompleted {
		t.Fatalf("replayed events = %+v, original = %+v", got, original)
	}
}

func TestDeterministicRuntimeReplaysAfterSessionSequence(t *testing.T) {
	store := newReplayStore()
	first := NewDeterministicRuntime(NewDeterministicProvider(), store, 1)
	run, err := first.Start(context.Background(), AgentRunRequest{SessionID: "session-sequence", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	original := collectReplayTestEvents(t, run.Events)
	persisted, err := store.Events(context.Background(), run.SessionID, 0)
	if err != nil || len(persisted) != len(original) {
		t.Fatalf("persisted events = %d, err = %v", len(persisted), err)
	}
	first.Close()

	second := NewDeterministicRuntime(NewDeterministicProvider(), store, 1)
	lastSequence := strconv.FormatInt(persisted[0].Sequence, 10)
	replayed, err := second.SubscribeFrom(context.Background(), run.ID, lastSequence)
	if err != nil {
		t.Fatal(err)
	}
	got := collectReplayTestEvents(t, replayed)
	if len(got) != len(original)-1 || got[0].ID != original[1].ID {
		t.Fatalf("sequence replay = %+v, original = %+v", got, original)
	}
}
