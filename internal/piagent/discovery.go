// Package piagent discovers optional Pi HTTP sidecars on the local PATH.
package piagent

import (
    "bytes"
    "context"
    "os/exec"
    "path/filepath"
    "strings"
    "time"
)

// Candidate describes a command that may host the pi-agent HTTP sidecar. It
// intentionally contains paths and version text only; credentials are never
// inspected or returned.
type Candidate struct {
    Name            string `json:"name"`
    Command         string `json:"command"`
    Path            string `json:"path"`
    Version         string `json:"version,omitempty"`
    SidecarCapable  bool   `json:"sidecar_capable"`
}

var commandNames = []string{"pi-agent-sidecar", "pi-sidecar", "pi"}

// Discover looks for well-known sidecar command names on PATH. Commands are
// probed with --version/--help under short deadlines, and only commands that
// advertise sidecar/server support (or use an explicit sidecar command name)
// are marked SidecarCapable. A regular `pi` CLI is therefore never started as
// an HTTP server just because it happens to be installed.
func Discover(ctx context.Context) []Candidate {
    if ctx == nil { ctx = context.Background() }
    candidates := make([]Candidate, 0, len(commandNames))
    seen := map[string]struct{}{}
    for _, name := range commandNames {
        resolved, err := exec.LookPath(name)
        if err != nil { continue }
        if _, ok := seen[resolved]; ok { continue }
        seen[resolved] = struct{}{}
        c := Candidate{Name: name, Command: name, Path: resolved}
        c.Version, c.SidecarCapable = probe(ctx, resolved, name)
        candidates = append(candidates, c)
    }
    return candidates
}

func probe(parent context.Context, path, name string) (string, bool) {
    // Explicit sidecar binaries have a stable contract by name. We still run
    // a harmless version probe to expose useful diagnostics in the API.
    explicit := strings.HasPrefix(filepath.Base(path), "pi-agent-sidecar") || strings.HasPrefix(filepath.Base(path), "pi-sidecar") || name == "pi-agent-sidecar" || name == "pi-sidecar"
    version := runProbe(parent, path, "--version")
    text := strings.TrimSpace(version)
    capable := explicit || containsSidecarHint(text)
    if !capable {
        help := runProbe(parent, path, "--help")
        if text == "" { text = strings.TrimSpace(help) }
        capable = containsSidecarHint(help)
    }
    if text != "" {
        text = strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")[0]
        if len(text) > 256 { text = text[:256] }
    }
    return text, capable
}

func runProbe(parent context.Context, path string, arg string) string {
    ctx, cancel := context.WithTimeout(parent, 750*time.Millisecond)
    defer cancel()
    cmd := exec.CommandContext(ctx, path, arg)
    var out bytes.Buffer
    cmd.Stdout, cmd.Stderr = &out, &out
    _ = cmd.Run()
    return out.String()
}

func containsSidecarHint(value string) bool {
    lower := strings.ToLower(value)
    hints := []string{"sidecar", "http server", "http-service", "--port", "--host", "pi-agent/v1"}
    for _, hint := range hints {
        if strings.Contains(lower, hint) { return true }
    }
    return false
}

// FirstSidecar returns the first discovered command that can be started as a
// sidecar, preserving the documented command order.
func FirstSidecar(ctx context.Context) (Candidate, bool) {
    for _, c := range Discover(ctx) {
        if c.SidecarCapable { return c, true }
    }
    return Candidate{}, false
}
