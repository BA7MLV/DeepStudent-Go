package runtime

import (
	"context"
	"errors"
	"testing"
	"time"
)

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
	case _, ok := <-run.Events:
		if ok {
			t.Fatal("canceled run emitted an event")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for canceled run")
	}
	if errors.Is(ctx.Err(), context.Canceled) == false {
		t.Fatal("test context was not canceled")
	}
}
