package piagent

import (
    "context"
    "os"
    "path/filepath"
    "strings"
    "testing"
)

func writeProbeCommand(t *testing.T, dir, name, output string) {
    t.Helper()
    path := filepath.Join(dir, name)
    script := "#!/bin/sh\nprintf '%s\\n' " + quoteShell(output) + "\n"
    if err := os.WriteFile(path, []byte(script), 0o755); err != nil { t.Fatal(err) }
}

func quoteShell(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func TestDiscoverDoesNotTreatRegularPiAsSidecar(t *testing.T) {
    dir := t.TempDir()
    writeProbeCommand(t, dir, "pi", "pi 1.0")
    t.Setenv("PATH", dir)
    candidates := Discover(context.Background())
    if len(candidates) != 1 || candidates[0].Name != "pi" { t.Fatalf("candidates = %+v", candidates) }
    if candidates[0].SidecarCapable { t.Fatalf("regular pi CLI was marked sidecar-capable: %+v", candidates[0]) }
}

func TestDiscoverRecognizesExplicitSidecarCommand(t *testing.T) {
    dir := t.TempDir()
    writeProbeCommand(t, dir, "pi-sidecar", "pi-sidecar 2.1")
    t.Setenv("PATH", dir)
    candidates := Discover(context.Background())
    if len(candidates) != 1 { t.Fatalf("candidates = %+v", candidates) }
    if !candidates[0].SidecarCapable || candidates[0].Version != "pi-sidecar 2.1" { t.Fatalf("unexpected candidate = %+v", candidates[0]) }
}
