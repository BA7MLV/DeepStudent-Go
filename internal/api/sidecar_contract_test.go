package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
)

func TestHTTPContractSidecarRuntimeSSEToolOrdering(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost || req.URL.Path != "/run" {
			http.NotFound(w, req)
			return
		}
		var request runtime.AgentRunRequest
		if err := json.NewDecoder(req.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		for _, envelope := range []runtime.SidecarEnvelope{
			{Protocol: runtime.SidecarProtocol, RunID: request.RunID, Sequence: 1, Type: runtime.SidecarRunStarted},
			{Protocol: runtime.SidecarProtocol, RunID: request.RunID, Sequence: 2, Type: runtime.SidecarMessageDelta, Payload: json.RawMessage(`{"delta":"hello"}`)},
			{Protocol: runtime.SidecarProtocol, RunID: request.RunID, Sequence: 3, Type: runtime.SidecarToolCall, Payload: json.RawMessage(`{"call_id":"c1","tool_name":"clock","arguments":{"tz":"UTC"}}`)},
			{Protocol: runtime.SidecarProtocol, RunID: request.RunID, Sequence: 4, Type: runtime.SidecarToolResult, Payload: json.RawMessage(`{"call_id":"c1","tool_name":"clock","output":{"hour":12}}`)},
			{Protocol: runtime.SidecarProtocol, RunID: request.RunID, Sequence: 5, Type: runtime.SidecarMessageDelta, Payload: json.RawMessage(`{"delta":"done"}`)},
			{Protocol: runtime.SidecarProtocol, RunID: request.RunID, Sequence: 6, Type: runtime.SidecarRunCompleted},
		} {
			if err := runtime.WriteSidecarEnvelope(w, envelope); err != nil {
				return
			}
		}
	}))
	defer sidecar.Close()
	agent, err := runtime.NewSidecarRuntime(sidecar.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	apiServer := httptest.NewServer(NewServer(config.Defaults(), agent))
	defer apiServer.Close()

	response, err := http.Post(apiServer.URL+"/api/v1/runs", "application/json", strings.NewReader(`{"prompt":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /runs status=%d body=%s", response.StatusCode, response.Body.String())
	}
	var accepted acceptedRunContract
	decodeJSONBody(t, response, &accepted)
	if accepted.RunID == "" || accepted.EventsURL == "" {
		t.Fatalf("accepted run = %+v", accepted)
	}

	eventsResponse, err := http.Get(apiServer.URL + accepted.EventsURL)
	if err != nil {
		t.Fatal(err)
	}
	defer eventsResponse.Body.Close()
	if eventsResponse.StatusCode != http.StatusOK {
		t.Fatalf("SSE status=%d", eventsResponse.StatusCode)
	}
	body, err := io.ReadAll(eventsResponse.Body)
	if err != nil {
		t.Fatal(err)
	}
	events := parseSSEContract(t, string(body))
	if len(events) != 6 {
		t.Fatalf("SSE events = %+v", events)
	}
	want := []string{"run.started", "message.delta", "tool.call", "tool.result", "message.delta", "run.completed"}
	for i, event := range events {
		if event.Type != want[i] || event.ID != strconv.Itoa(i+1) {
			t.Fatalf("SSE event %d = %+v, want type=%s id=%d", i, event, want[i], i+1)
		}
	}
	if toolCall, ok := events[2].Data["tool_call"].(map[string]any); !ok || toolCall["name"] != "clock" {
		t.Fatalf("tool.call SSE payload = %+v", events[2].Data)
	}
	if toolResult, ok := events[3].Data["tool_result"].(map[string]any); !ok || toolResult["call_id"] != "c1" {
		t.Fatalf("tool.result SSE payload = %+v", events[3].Data)
	}
}
