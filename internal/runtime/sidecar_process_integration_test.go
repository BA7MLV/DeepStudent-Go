package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestSidecarRuntimeRealProcess exercises the process boundary instead of an
// httptest implementation. It intentionally uses the sidecar's deterministic
// fake mode: no provider credentials or network calls are needed, while the
// Go runtime still has to decode the real NDJSON stream and persist every
// event/message in the session store.
func TestSidecarRuntimeRealProcess(t *testing.T) {
	repoRoot := repositoryRoot(t)
	sidecarDir := filepath.Join(repoRoot, "packages", "agent-sidecar")
	if _, err := os.Stat(filepath.Join(sidecarDir, "src", "index.js")); err != nil {
		t.Skipf("agent-sidecar source is unavailable: %v", err)
	}
	// Go tests run before the sidecar npm install in the repository workflow.
	// Keep the integration test visible in that stage while avoiding a false
	// failure when the optional Node dependencies have not been materialized.
	if _, err := os.Stat(filepath.Join(sidecarDir, "node_modules", "@mariozechner", "pi-agent-core", "package.json")); err != nil {
		t.Skipf("agent-sidecar dependencies are not installed (run npm install --prefix packages/agent-sidecar): %v", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node is not installed: %v", err)
	}

	port := freeTCPPort(t)
	cmd := exec.Command(node, "src/index.js")
	cmd.Dir = sidecarDir
	cmd.Env = append(os.Environ(),
		"PI_SIDECAR_HOST=127.0.0.1",
		"PI_SIDECAR_PORT="+strconv.Itoa(port),
		"PI_SIDECAR_MODE=fake",
		"PI_FAKE_DELAY_MS=0",
	)
	stdout, stderr := &strings.Builder{}, &strings.Builder{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start agent-sidecar: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process == nil {
			return
		}
		_ = cmd.Process.Signal(syscall.SIGTERM)
		wait := make(chan error, 1)
		go func() { wait <- cmd.Wait() }()
		select {
		case <-wait:
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-wait
		}
	})

	endpoint := "http://127.0.0.1:" + strconv.Itoa(port)
	waitForSidecar(t, endpoint, cmd, stdout, stderr)
	store := NewMemorySessionStore()
	runtime, err := NewSidecarRuntime(endpoint, store)
	if err != nil {
		t.Fatalf("new sidecar runtime: %v", err)
	}
	defer runtime.Close()
	if err := runtime.Health(context.Background()); err != nil {
		t.Fatalf("sidecar health: %v", err)
	}

	const (
		runID     = "process-run"
		sessionID = "process-session"
		prompt    = "hello from a real node sidecar"
	)
	runContext, cancelRun := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelRun()
	run, err := runtime.Start(runContext, AgentRunRequest{
		RunID: runID, SessionID: sessionID, Prompt: prompt, Provider: "sidecar", Model: "fake",
	})
	if err != nil {
		t.Fatalf("start runtime run: %v", err)
	}

	var events []StreamEvent
	for event := range run.Events {
		events = append(events, event)
	}
	wantTypes := []StreamEventType{EventRunStarted, EventToolCall, EventToolResult, EventTextDelta, EventRunCompleted}
	gotTypes := make([]StreamEventType, len(events))
	for i, event := range events {
		gotTypes[i] = event.Type
		if event.ID != strconv.Itoa(i+1) {
			t.Fatalf("event %d id = %q, want %d (sidecar NDJSON seq)", i, event.ID, i+1)
		}
		if event.RunID != runID {
			t.Fatalf("event %d run id = %q, want %q", i, event.RunID, runID)
		}
	}
	if !reflect.DeepEqual(gotTypes, wantTypes) {
		t.Fatalf("event types = %v, want %v", gotTypes, wantTypes)
	}
	if events[len(events)-1].Done != true {
		t.Fatalf("terminal event = %+v", events[len(events)-1])
	}
	if events[1].ToolCall == nil || events[1].ToolCall.Name != "deterministic" {
		t.Fatalf("tool.call event = %+v", events[1])
	}
	var toolArgs map[string]string
	if err := json.Unmarshal(events[1].ToolCall.Arguments, &toolArgs); err != nil {
		t.Fatalf("decode tool.call arguments: %v", err)
	}
	if toolArgs["input"] != prompt {
		t.Fatalf("tool.call input = %q, want %q", toolArgs["input"], prompt)
	}
	if events[2].ToolResult == nil || events[2].ToolResult.Name != "deterministic" || events[2].ToolResult.CallID != events[1].ToolCall.ID {
		t.Fatalf("tool.result event = %+v", events[2])
	}
	var toolOutput struct {
		Input  string `json:"input"`
		Length int    `json:"length"`
	}
	if err := json.Unmarshal(events[2].ToolResult.Output, &toolOutput); err != nil {
		t.Fatalf("decode tool.result output: %v", err)
	}
	if toolOutput.Input != prompt || toolOutput.Length != len(prompt) {
		t.Fatalf("tool.result output = %+v, want input=%q length=%d", toolOutput, prompt, len(prompt))
	}
	if !strings.Contains(events[3].Delta, "Deterministic result:") {
		t.Fatalf("message.delta = %q", events[3].Delta)
	}

	persisted, err := store.Events(context.Background(), sessionID, 0)
	if err != nil {
		t.Fatalf("read persisted events: %v", err)
	}
	if len(persisted) != len(events) {
		t.Fatalf("persisted event count = %d, streamed = %d", len(persisted), len(events))
	}
	for i, record := range persisted {
		if record.Sequence != int64(i+1) || record.RunID != runID || record.Type != string(events[i].Type) {
			t.Fatalf("persisted event %d = %+v, streamed = %+v", i, record, events[i])
		}
		var replay StreamEvent
		if err := json.Unmarshal(record.Payload, &replay); err != nil {
			t.Fatalf("decode persisted event %d: %v", i, err)
		}
		if replay.ID != events[i].ID || replay.Type != events[i].Type {
			t.Fatalf("persisted payload %d = %+v, streamed = %+v", i, replay, events[i])
		}
	}
	messages, err := store.Messages(context.Background(), sessionID, time.Time{})
	if err != nil {
		t.Fatalf("read persisted messages: %v", err)
	}
	if len(messages) != 1 || messages[0].Role != "assistant" || messages[0].RunID != runID || !strings.Contains(messages[0].Content, "Deterministic result:") {
		t.Fatalf("persisted assistant messages = %+v", messages)
	}
	record, err := runtime.Run(context.Background(), runID)
	if err != nil {
		t.Fatalf("read terminal run: %v", err)
	}
	if record.Status != RunCompleted || record.FinishedAt == nil {
		t.Fatalf("terminal run record = %+v", record)
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// This test is in internal/runtime; walk up to the repository root so it
	// also works when invoked with `go test ./...` from another working dir.
	root := cwd
	for i := 0; i < 4; i++ {
		if _, err := os.Stat(filepath.Join(root, "packages", "agent-sidecar", "src", "index.js")); err == nil {
			return root
		}
		root = filepath.Dir(root)
	}
	t.Fatalf("could not locate repository root from %s", cwd)
	return ""
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve sidecar port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func waitForSidecar(t *testing.T, endpoint string, cmd *exec.Cmd, stdout, stderr *strings.Builder) {
	t.Helper()
	client := &http.Client{Timeout: 200 * time.Millisecond}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get(endpoint + "/healthz")
		if err == nil {
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			if readErr == nil && response.StatusCode == http.StatusOK {
				var health struct {
					OK       bool   `json:"ok"`
					Protocol string `json:"protocol"`
					Mode     string `json:"mode"`
				}
				if json.Unmarshal(body, &health) == nil && health.OK && health.Protocol == SidecarProtocol && health.Mode == "fake" {
					return
				}
			}
		}
		if cmd.ProcessState != nil {
			t.Fatalf("agent-sidecar exited before health: %v; stdout=%s stderr=%s", cmd.ProcessState, stdout.String(), stderr.String())
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("agent-sidecar did not become healthy; stdout=%s stderr=%s", stdout.String(), stderr.String())
}
