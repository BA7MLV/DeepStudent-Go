package runtime

import (
	"context"
	"testing"
	"time"
)

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
