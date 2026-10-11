package runtime

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// SidecarProtocol identifies the loopback NDJSON contract between the Go API
// and a pi-agent-core process. The value is deliberately versioned separately
// from the public HTTP API so the sidecar can evolve without changing SSE.
const SidecarProtocol = "pi-agent/v1"

// SidecarEnvelope is one newline-delimited record emitted by the Pi sidecar.
// Payload is event-specific JSON. Sequence starts at one and is monotonic per
// run; the Go adapter uses it as the SSE event id and replay cursor.
type SidecarEnvelope struct {
	Protocol string          `json:"protocol"`
	RunID    string          `json:"run_id"`
	Sequence int64           `json:"seq"`
	Type     string          `json:"type"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// Sidecar event names are intentionally strings to allow a newer sidecar to
// add events without making older Go clients unable to consume the stream.
const (
	SidecarRunStarted   = "run.started"
	SidecarMessageDelta = "message.delta"
	SidecarToolCall     = "tool.call"
	SidecarToolResult   = "tool.result"
	SidecarRunCompleted = "run.completed"
	SidecarRunError     = "run.error"
	SidecarRunCanceled  = "run.canceled"
)

// SidecarTextPayload is the payload for message.delta. Text is accepted as an
// alias for delta to make the bridge tolerant of Pi UI adapters.
type SidecarTextPayload struct {
	Delta string `json:"delta,omitempty"`
	Text  string `json:"text,omitempty"`
}

// SidecarToolCallPayload is emitted at tool_execution_start, after Pi has
// parsed and validated the tool arguments.
type SidecarToolCallPayload struct {
	CallID    string          `json:"call_id,omitempty"`
	ToolName  string          `json:"tool_name,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// SidecarToolResultPayload is emitted at tool_execution_end. A failed tool is
// represented as an error result so the model can decide how to continue.
type SidecarToolResultPayload struct {
	CallID       string          `json:"call_id,omitempty"`
	ToolName     string          `json:"tool_name,omitempty"`
	Name         string          `json:"name,omitempty"`
	Output       json.RawMessage `json:"output,omitempty"`
	Error        bool            `json:"error,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
	Result       json.RawMessage `json:"result,omitempty"`
}

// SidecarErrorPayload is the terminal run.error payload.
type SidecarErrorPayload struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// Validate checks envelope invariants that are independent from the event
// payload. Unknown event names are valid and are passed through as metadata so
// newer sidecars remain observable by older Go servers.
func (e SidecarEnvelope) Validate() error {
	if strings.TrimSpace(e.Protocol) != SidecarProtocol {
		return fmt.Errorf("unsupported sidecar protocol %q", e.Protocol)
	}
	if strings.TrimSpace(e.RunID) == "" {
		return errors.New("sidecar run_id is required")
	}
	if e.Sequence <= 0 {
		return errors.New("sidecar seq must be positive")
	}
	if strings.TrimSpace(e.Type) == "" {
		return errors.New("sidecar type is required")
	}
	if len(e.Payload) > 0 && !json.Valid(e.Payload) {
		return errors.New("sidecar payload must be valid JSON")
	}
	return nil
}

// WriteSidecarEnvelope writes one canonical NDJSON record. It does not flush a
// buffered writer; HTTP callers should flush after each record.
func WriteSidecarEnvelope(w io.Writer, envelope SidecarEnvelope) error {
	if w == nil {
		return errors.New("sidecar writer is required")
	}
	if err := envelope.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode sidecar envelope: %w", err)
	}
	data = append(data, '\n')
	_, err = w.Write(data)
	if err != nil {
		return fmt.Errorf("write sidecar envelope: %w", err)
	}
	return nil
}

// ReadSidecarEnvelopes decodes an NDJSON stream and invokes handle in stream
// order. Blank lines are ignored. A run id and sequence regression are
// rejected because they would make SSE Last-Event-ID replay ambiguous.
func ReadSidecarEnvelopes(r io.Reader, handle func(SidecarEnvelope) error) error {
	if r == nil {
		return errors.New("sidecar reader is required")
	}
	if handle == nil {
		return errors.New("sidecar envelope handler is required")
	}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 16*1024), 2<<20)
	var runID string
	var lastSequence int64
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var envelope SidecarEnvelope
		if err := json.Unmarshal(line, &envelope); err != nil {
			return fmt.Errorf("decode sidecar envelope: %w", err)
		}
		if err := envelope.Validate(); err != nil {
			return err
		}
		if runID == "" {
			runID = envelope.RunID
		} else if envelope.RunID != runID {
			return fmt.Errorf("sidecar run_id changed from %q to %q", runID, envelope.RunID)
		}
		if envelope.Sequence <= lastSequence {
			return fmt.Errorf("sidecar seq %d is not greater than %d", envelope.Sequence, lastSequence)
		}
		lastSequence = envelope.Sequence
		if err := handle(envelope); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read sidecar stream: %w", err)
	}
	return nil
}

// StreamEvent converts one sidecar envelope to the provider-neutral SSE event
// already understood by the Go API. now is injected for deterministic tests.
func (e SidecarEnvelope) StreamEvent(now time.Time) (StreamEvent, error) {
	if err := e.Validate(); err != nil {
		return StreamEvent{}, err
	}
	if now.IsZero() {
		now = time.Now()
	}
	event := StreamEvent{ID: fmt.Sprintf("%d", e.Sequence), RunID: e.RunID, Type: StreamEventType(e.Type), CreatedAt: now.UTC()}
	switch e.Type {
	case SidecarRunStarted:
		return event, nil
	case SidecarMessageDelta:
		var payload SidecarTextPayload
		if err := decodeSidecarPayload(e.Payload, &payload); err != nil {
			return StreamEvent{}, err
		}
		if payload.Delta == "" {
			payload.Delta = payload.Text
		}
		event.Delta, event.Text = payload.Delta, payload.Delta
		return event, nil
	case SidecarToolCall:
		var payload SidecarToolCallPayload
		if err := decodeSidecarPayload(e.Payload, &payload); err != nil {
			return StreamEvent{}, err
		}
		name := payload.ToolName
		if name == "" {
			name = payload.Name
		}
		if strings.TrimSpace(name) == "" {
			return StreamEvent{}, errors.New("sidecar tool.call name is required")
		}
		args := payload.Arguments
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		if !json.Valid(args) {
			return StreamEvent{}, errors.New("sidecar tool.call arguments must be valid JSON")
		}
		event.ToolCall = &ToolCall{ID: payload.CallID, Name: name, Arguments: append(json.RawMessage(nil), args...)}
		event.Metadata = map[string]any{
			// Keep the flat aliases used by older browser adapters while exposing
			// the typed ToolCall field to newer clients.
			"tool_call_id": payload.CallID,
			"tool_name":    name,
			"arguments":    json.RawMessage(args),
		}
		return event, nil
	case SidecarToolResult:
		var payload SidecarToolResultPayload
		if err := decodeSidecarPayload(e.Payload, &payload); err != nil {
			return StreamEvent{}, err
		}
		name := payload.ToolName
		if name == "" {
			name = payload.Name
		}
		output := payload.Output
		if len(output) == 0 {
			output = payload.Result
		}
		event.ToolResult = &ToolResult{CallID: payload.CallID, Name: name, Output: append(json.RawMessage(nil), output...), Error: payload.Error, ErrorMessage: payload.ErrorMessage}
		event.Metadata = map[string]any{
			"tool_call_id":  payload.CallID,
			"tool_name":     name,
			"output":        json.RawMessage(output),
			"error":         payload.Error,
			"error_message": payload.ErrorMessage,
		}
		return event, nil
	case SidecarRunCompleted:
		event.Done = true
		return event, nil
	case SidecarRunCanceled:
		event.Done = true
		event.ErrorCode = "canceled"
		return event, nil
	case SidecarRunError:
		var payload SidecarErrorPayload
		if err := decodeSidecarPayload(e.Payload, &payload); err != nil {
			return StreamEvent{}, err
		}
		event.Done, event.ErrorCode, event.ErrorMessage = true, payload.Code, payload.Message
		return event, nil
	default:
		// Preserve unknown events for observability without making the SSE
		// bridge fail when the sidecar learns a new event type.
		if len(e.Payload) > 0 {
			var metadata map[string]any
			if err := json.Unmarshal(e.Payload, &metadata); err == nil {
				event.Metadata = metadata
			} else {
				event.Metadata = map[string]any{"payload": json.RawMessage(e.Payload)}
			}
		}
		return event, nil
	}
}

func decodeSidecarPayload(data json.RawMessage, target any) error {
	if len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("decode sidecar payload: %w", err)
	}
	return nil
}
