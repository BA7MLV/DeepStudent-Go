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
	EventRunCanceled  StreamEventType = "run.canceled"
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
	ID        string    `json:"id,omitempty"`
	SessionID string    `json:"session_id,omitempty"`
	RunID     string    `json:"run_id,omitempty"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at,omitempty"`
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

type Session struct {
	ID        string    `json:"id"`
	Title     string    `json:"title,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
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

// SessionCatalog is the optional query/write surface used by the HTTP session
// and message endpoints. Keeping it separate preserves compatibility with
// small in-memory SessionStore implementations.
type SessionCatalog interface {
	SessionStore
	CreateSessionWithTitle(ctx context.Context, session Session) (Session, error)
	GetSession(ctx context.Context, sessionID string) (Session, error)
	ListSessions(ctx context.Context, limit, offset int) ([]Session, error)
	AppendMessage(ctx context.Context, message Message) (Message, error)
	Messages(ctx context.Context, sessionID string, after time.Time) ([]Message, error)
}

type RunStatus string

const (
	RunQueued    RunStatus = "queued"
	RunRunning   RunStatus = "running"
	RunCompleted RunStatus = "completed"
	RunFailed    RunStatus = "failed"
	RunCanceled  RunStatus = "canceled"
)

type RunRecord struct {
	ID        string     `json:"id"`
	SessionID string     `json:"session_id,omitempty"`
	Provider  string     `json:"provider,omitempty"`
	Model     string     `json:"model,omitempty"`
	Status    RunStatus  `json:"status"`
	CreatedAt time.Time  `json:"created_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// RunInspector is optional and allows status/cancel endpoints without
// expanding AgentRuntime's minimum start/subscribe contract.
type RunInspector interface {
	Run(ctx context.Context, runID string) (RunRecord, error)
	Cancel(ctx context.Context, runID string) error
}

// RunReader is the persistence-only status lookup used after in-memory
// retention expires.
type RunReader interface {
	Run(ctx context.Context, runID string) (RunRecord, error)
}

type RunStore interface {
	CreateRun(ctx context.Context, run RunRecord) error
	FinishRun(ctx context.Context, runID string, status RunStatus, finishedAt time.Time) error
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
