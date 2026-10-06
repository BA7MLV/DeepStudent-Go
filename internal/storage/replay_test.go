package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
)

func collectSQLiteReplayTestEvents(t *testing.T, events <-chan runtime.StreamEvent) []runtime.StreamEvent {
	t.Helper()
	result := make([]runtime.StreamEvent, 0)
	deadline := time.After(time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return result
			}
			result = append(result, event)
		case <-deadline:
			t.Fatal("timed out waiting for events")
		}
	}
}

func TestSQLiteSessionEventsReplayAcrossRuntimeRestart(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "deepstudent.db")
	ctx := context.Background()
	store, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	first := runtime.NewDeterministicRuntime(runtime.NewDeterministicProvider(), store, 1)
	run, err := first.Start(ctx, runtime.AgentRunRequest{SessionID: "sqlite-replay", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	original := collectSQLiteReplayTestEvents(t, run.Events)
	if len(original) < 3 {
		t.Fatalf("expected stream events, got %d", len(original))
	}
	first.Close()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	// Opening the same file through a new SQLite connection models a process
	// restart. No in-memory run broker is shared with the first runtime.
	reopened, err := OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	second := runtime.NewDeterministicRuntime(runtime.NewDeterministicProvider(), reopened, 1)
	replayed, err := second.SubscribeFrom(ctx, run.ID, original[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	got := collectSQLiteReplayTestEvents(t, replayed)
	if len(got) != len(original)-1 || got[0].ID != original[1].ID || got[len(got)-1].Type != runtime.EventRunCompleted {
		t.Fatalf("replayed events = %+v, original = %+v", got, original)
	}
}
