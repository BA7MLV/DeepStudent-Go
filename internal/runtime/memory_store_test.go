package runtime

import (
	"context"
	"errors"
	"testing"
)

func TestMemorySessionStoreMessageIDsAreIdempotent(t *testing.T) {
	store := NewMemorySessionStore()
	first, err := store.AppendMessage(context.Background(), Message{ID: "client-1", SessionID: "session-1", RunID: "run-1", Role: "user", Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.AppendMessage(context.Background(), Message{ID: "client-1", SessionID: "session-1", RunID: "run-2", Role: "user", Content: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if second.RunID != first.RunID {
		t.Fatalf("retry changed reserved run id: first=%q second=%q", first.RunID, second.RunID)
	}
	messages, err := store.Messages(context.Background(), "session-1", first.CreatedAt.Add(-1))
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 {
		t.Fatalf("retry duplicated message: %+v", messages)
	}
	_, err = store.AppendMessage(context.Background(), Message{ID: "client-1", SessionID: "session-1", RunID: "run-3", Role: "user", Content: "different"})
	if !errors.Is(err, ErrMessageConflict) {
		t.Fatalf("conflicting retry error = %v, want ErrMessageConflict", err)
	}
}
