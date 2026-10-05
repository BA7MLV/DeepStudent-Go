package runtime

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSidecarEnvelopeRoundTripAndStreamMapping(t *testing.T) {
	var stream bytes.Buffer
	envelopes := []SidecarEnvelope{
		{Protocol: SidecarProtocol, RunID: "run-1", Sequence: 1, Type: SidecarRunStarted},
		{Protocol: SidecarProtocol, RunID: "run-1", Sequence: 2, Type: SidecarMessageDelta, Payload: json.RawMessage(`{"delta":"hello"}`)},
		{Protocol: SidecarProtocol, RunID: "run-1", Sequence: 3, Type: SidecarToolCall, Payload: json.RawMessage(`{"call_id":"call-1","tool_name":"clock","arguments":{"tz":"UTC"}}`)},
		{Protocol: SidecarProtocol, RunID: "run-1", Sequence: 4, Type: SidecarToolResult, Payload: json.RawMessage(`{"call_id":"call-1","tool_name":"clock","output":{"hour":12}}`)},
		{Protocol: SidecarProtocol, RunID: "run-1", Sequence: 5, Type: SidecarRunCompleted},
	}
	for _, envelope := range envelopes {
		if err := WriteSidecarEnvelope(&stream, envelope); err != nil {
			t.Fatalf("write envelope: %v", err)
		}
	}
	var got []StreamEvent
	if err := ReadSidecarEnvelopes(&stream, func(envelope SidecarEnvelope) error {
		event, err := envelope.StreamEvent(time.Unix(123, 0))
		if err != nil {
			return err
		}
		got = append(got, event)
		return nil
	}); err != nil {
		t.Fatalf("read envelopes: %v", err)
	}
	if len(got) != len(envelopes) || got[1].Delta != "hello" || got[2].ToolCall == nil || got[2].ToolCall.Name != "clock" || got[3].ToolResult == nil || !got[4].Done {
		t.Fatalf("mapped events = %+v", got)
	}
	if got[0].ID != "1" || got[4].Type != EventRunCompleted {
		t.Fatalf("mapped event ids/types = %+v", got)
	}
}

func TestReadSidecarEnvelopesRejectsSequenceRegressionAndRunChange(t *testing.T) {
	for name, input := range map[string]string{
		"sequence regression": `{"protocol":"pi-agent/v1","run_id":"r","seq":1,"type":"run.started"}
{"protocol":"pi-agent/v1","run_id":"r","seq":1,"type":"run.completed"}`,
		"run change": `{"protocol":"pi-agent/v1","run_id":"r","seq":1,"type":"run.started"}
{"protocol":"pi-agent/v1","run_id":"other","seq":2,"type":"run.completed"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ReadSidecarEnvelopes(strings.NewReader(input), func(SidecarEnvelope) error { return nil }); err == nil {
				t.Fatal("expected stream validation error")
			}
		})
	}
}

func TestSidecarUnknownEventIsForwardCompatible(t *testing.T) {
	envelope := SidecarEnvelope{Protocol: SidecarProtocol, RunID: "r", Sequence: 1, Type: "message.reasoning_delta", Payload: json.RawMessage(`{"delta":"thinking"}`)}
	event, err := envelope.StreamEvent(time.Unix(123, 0))
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != StreamEventType("message.reasoning_delta") || event.Metadata["delta"] != "thinking" {
		t.Fatalf("unknown event = %+v", event)
	}
	scalar, err := (SidecarEnvelope{Protocol: SidecarProtocol, RunID: "r", Sequence: 2, Type: "message.progress", Payload: json.RawMessage(`"working"`)}).StreamEvent(time.Unix(123, 0))
	if err != nil || string(scalar.Metadata["payload"].(json.RawMessage)) != `"working"` {
		t.Fatalf("unknown scalar event = %+v, err=%v", scalar, err)
	}
}

func TestSidecarEnvelopeValidation(t *testing.T) {
	cases := []SidecarEnvelope{
		{Protocol: "pi-agent/v0", RunID: "r", Sequence: 1, Type: SidecarRunStarted},
		{Protocol: SidecarProtocol, RunID: "", Sequence: 1, Type: SidecarRunStarted},
		{Protocol: SidecarProtocol, RunID: "r", Sequence: 0, Type: SidecarRunStarted},
		{Protocol: SidecarProtocol, RunID: "r", Sequence: 1, Type: SidecarRunStarted, Payload: json.RawMessage(`{`)},
	}
	for _, envelope := range cases {
		if err := envelope.Validate(); err == nil {
			t.Fatalf("expected validation error for %+v", envelope)
		}
	}
}
