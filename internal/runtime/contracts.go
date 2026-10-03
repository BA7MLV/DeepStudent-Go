// Package runtime contains provider-neutral model and agent contracts.
package runtime

import (
	"context"
	"encoding/json"
	"time"
)

type StreamEventType string

const (
	EventRunStarted   StreamEventType = "run.started"
	EventTextDelta    StreamEventType = "message.delta"
	EventToolCall     StreamEventType = "tool.call"
	EventRunCompleted StreamEventType = "run.completed"
	EventRunError     StreamEventType = "run.error"
)

type StreamEvent struct {
	ID           string          `json:"id"`
	RunID        string          `json:"run_id"`
	Type         StreamEventType `json:"type"`
	Delta        string          `json:"delta,omitempty"`
	Text         string          `json:"text,omitempty"`
	ErrorCode    string          `json:"error_code,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
	Done         bool            `json:"done,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
	Metadata     map[string]any  `json:"metadata,omitempty"`
}

type ModelRequest struct {
	Provider          string         `json:"provider,omitempty"`
	Model             string         `json:"model,omitempty"`
	ReasoningEffort   string         `json:"reasoning_effort,omitempty"`
	Messages          []Message      `json:"messages,omitempty"`
	Prompt            string         `json:"prompt,omitempty"`
	MaxTokens         int            `json:"max_tokens,omitempty"`
	InputCapabilities []string       `json:"input_capabilities,omitempty"`
	Input             []string       `json:"input,omitempty"`
	Temperature       float64        `json:"temperature,omitempty"`
	Metadata          map[string]any `json:"metadata,omitempty"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ModelProvider emits provider-neutral events. Implementations must not expose
// provider credentials in events or errors.
type ModelProvider interface {
	Name() string
	Stream(ctx context.Context, request ModelRequest, emit func(StreamEvent) error) error
}

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema,omitempty"`
}

type ToolRegistry interface {
	List(ctx context.Context) ([]Tool, error)
	Call(ctx context.Context, name string, input json.RawMessage) (json.RawMessage, error)
}

type SessionEvent struct {
	Sequence  int64           `json:"sequence"`
	SessionID string          `json:"session_id"`
	RunID     string          `json:"run_id,omitempty"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

type SessionStore interface {
	CreateSession(ctx context.Context, sessionID string) error
	AppendEvent(ctx context.Context, event SessionEvent) (SessionEvent, error)
	Events(ctx context.Context, sessionID string, afterSequence int64) ([]SessionEvent, error)
}

type AgentRunRequest struct {
	RunID             string   `json:"run_id,omitempty"`
	SessionID         string   `json:"session_id,omitempty"`
	Prompt            string   `json:"prompt"`
	Provider          string   `json:"provider,omitempty"`
	Model             string   `json:"model,omitempty"`
	ReasoningEffort   string   `json:"reasoning_effort,omitempty"`
	MaxTokens         int      `json:"max_tokens,omitempty"`
	InputCapabilities []string `json:"input_capabilities,omitempty"`
	Input             []string `json:"input,omitempty"`
}

type AgentRun struct {
	ID        string
	SessionID string
	Events    <-chan StreamEvent
}

type AgentRuntime interface {
	Start(ctx context.Context, request AgentRunRequest) (AgentRun, error)
	Subscribe(ctx context.Context, runID string) (<-chan StreamEvent, error)
}
