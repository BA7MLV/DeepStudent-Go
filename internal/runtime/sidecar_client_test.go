package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestSidecarRuntimeFakeSidecarToolOrdering(t *testing.T) {
	var received AgentRunRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost || req.URL.Path != "/run" {
			http.NotFound(w, req)
			return
		}
		if err := json.NewDecoder(req.Body).Decode(&received); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		flusher, _ := w.(http.Flusher)
		for seq, record := range []struct {
			typ     string
			payload any
		}{
			{SidecarRunStarted, map[string]any{}},
			{SidecarMessageDelta, map[string]string{"delta": "before tool"}},
			{SidecarToolCall, map[string]any{"call_id": "call-1", "tool_name": "clock", "arguments": map[string]string{"tz": "UTC"}}},
			{SidecarToolResult, map[string]any{"call_id": "call-1", "tool_name": "clock", "output": map[string]int{"hour": 12}}},
			{SidecarMessageDelta, map[string]string{"delta": "after tool"}},
			{SidecarRunCompleted, map[string]any{}},
		} {
			payload, _ := json.Marshal(record.payload)
			if err := WriteSidecarEnvelope(w, SidecarEnvelope{Protocol: SidecarProtocol, RunID: received.RunID, Sequence: int64(seq + 1), Type: record.typ, Payload: payload}); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer server.Close()

	runtime, err := NewSidecarRuntime(server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	run, err := runtime.Start(context.Background(), AgentRunRequest{RunID: "run-e2e", SessionID: "session-e2e", Prompt: "use clock", Provider: "sidecar", Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	var events []StreamEvent
	for event := range run.Events {
		events = append(events, event)
	}
	if received.RunID != "run-e2e" || received.Prompt != "use clock" {
		t.Fatalf("sidecar request = %+v", received)
	}
	gotTypes := make([]StreamEventType, len(events))
	for i, event := range events {
		gotTypes[i] = event.Type
		if event.ID != strconv.Itoa(i+1) {
			t.Fatalf("event %d id = %q", i, event.ID)
		}
	}
	wantTypes := []StreamEventType{EventRunStarted, EventTextDelta, EventToolCall, EventToolResult, EventTextDelta, EventRunCompleted}
	if !reflect.DeepEqual(gotTypes, wantTypes) {
		t.Fatalf("event ordering = %v, want %v", gotTypes, wantTypes)
	}
	if events[2].ToolCall == nil || events[2].ToolCall.ID != "call-1" || events[2].ToolCall.Name != "clock" {
		t.Fatalf("tool call event = %+v", events[2])
	}
	if events[3].ToolResult == nil || events[3].ToolResult.CallID != "call-1" || events[3].ToolResult.Error {
		t.Fatalf("tool result event = %+v", events[3])
	}
	if events[len(events)-1].Done != true {
		t.Fatalf("terminal event = %+v", events[len(events)-1])
	}
	record, err := runtime.Run(context.Background(), "run-e2e")
	if err != nil || record.Status != RunCompleted {
		t.Fatalf("run status = %+v, err=%v", record, err)
	}
}

func TestSidecarRuntimeMalformedStreamProducesTerminalError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = fmt.Fprintf(w, "{"+`"protocol":"pi-agent/v1","run_id":"r","seq":1,"type":"run.started"`+"}\n")
		_, _ = fmt.Fprintf(w, "{"+`"protocol":"pi-agent/v1","run_id":"r","seq":1,"type":"run.completed"`+"}\n")
	}))
	defer server.Close()
	runtime, err := NewSidecarRuntime(server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := runtime.Start(context.Background(), AgentRunRequest{RunID: "r", Prompt: "malformed"})
	if err != nil {
		t.Fatal(err)
	}
	var events []StreamEvent
	for event := range run.Events {
		events = append(events, event)
	}
	if len(events) != 2 || events[0].Type != EventRunStarted || events[1].Type != EventRunError || !events[1].Done {
		t.Fatalf("malformed stream events = %+v", events)
	}
	if events[1].ErrorCode != "sidecar_stream_error" || !strings.Contains(events[1].ErrorMessage, "seq") {
		t.Fatalf("protocol error = %+v", events[1])
	}
	record, err := runtime.Run(context.Background(), "r")
	if err != nil || record.Status != RunFailed {
		t.Fatalf("failed run status = %+v, err=%v", record, err)
	}
}

func TestSidecarRuntimeReplaySkipsLastEventID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		for sequence, eventType := range []string{SidecarRunStarted, SidecarMessageDelta, SidecarRunCompleted} {
			payload := json.RawMessage(`{}`)
			if eventType == SidecarMessageDelta {
				payload = json.RawMessage(`{"delta":"hello"}`)
			}
			if err := WriteSidecarEnvelope(w, SidecarEnvelope{Protocol: SidecarProtocol, RunID: "replay", Sequence: int64(sequence + 1), Type: eventType, Payload: payload}); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	runtime, err := NewSidecarRuntime(server.URL, NewMemorySessionStore())
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	run, err := runtime.Start(context.Background(), AgentRunRequest{RunID: "replay", SessionID: "replay-session", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	var original []StreamEvent
	for event := range run.Events {
		original = append(original, event)
	}
	if len(original) != 3 {
		t.Fatalf("original events = %+v", original)
	}
	replayed, err := runtime.SubscribeFrom(context.Background(), run.ID, original[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []StreamEvent
	for event := range replayed {
		got = append(got, event)
	}
	if len(got) != 2 || got[0].ID != original[1].ID || got[len(got)-1].ID == original[0].ID {
		t.Fatalf("replayed events = %+v, original = %+v", got, original)
	}
}
