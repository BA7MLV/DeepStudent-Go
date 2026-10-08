// Package serverapp builds the local HTTP/SSE runtime and owns its resources.
// Both the headless server and the MyGo desktop use this package so they have
// identical provider, SQLite, attachment, and shutdown semantics.
package serverapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/api"
	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/piagent"
	"github.com/BA7MLV/DeepStudent-Go/internal/storage"
)

// Components contains the resources that must live at least as long as the
// HTTP server. Call Close after the listener has stopped accepting requests.
type Components struct {
	Store      *storage.SQLiteStore
	Attachments *storage.AttachmentStore
	Runtime    runtime.AgentRuntime
	API        *api.Server
	HTTP       *http.Server
	process    *managedSidecar
	readyStop  context.CancelFunc
}

func New(ctx context.Context, cfg config.Config) (*Components, error) {
	store, err := storage.OpenSQLite(ctx, cfg.Storage.SQLitePath)
	if err != nil {
		return nil, err
	}
	closeStore := true
	defer func() {
		if closeStore {
			_ = store.Close()
		}
	}()
	// Native settings updates are durable. Overlay the persisted routing and
	// sidecar choices before constructing providers so a restart uses the same
	// model/endpoint selected by the previous process.
	if restored, restoreErr := store.LoadConfig(ctx, cfg); restoreErr != nil {
		return nil, restoreErr
	} else {
		cfg = restored
	}
	attachmentStore, err := storage.NewAttachmentStore(store, cfg.Storage.BlobRoot, attachments.Policy{MaxBytes: cfg.Storage.AttachmentMaxBytes, AllowedMIMEs: cfg.Storage.AttachmentAllowedMIMEs})
	if err != nil {
		return nil, err
	}
	providers := map[string]runtime.ModelProvider{"deterministic": runtime.NewDeterministicProvider()}
	for name, profile := range cfg.Providers {
		if name == "deterministic" {
			continue
		}
		selection, resolveErr := cfg.ResolveModel(name, "")
		if resolveErr != nil {
			// Keep the deterministic runtime available even when an optional
			// provider profile is malformed. Requests selecting that provider
			// will fail validation instead of taking down the local app.
			continue
		}
		providers[name] = runtime.NewSiliconFlowProvider(runtime.SiliconFlowConfig{
			Name: name, BaseURL: selection.BaseURL, APIKeyEnv: profile.APIKeyEnv,
			Model: selection.Model, Timeout: selection.Timeout, MaxRetries: selection.MaxRetries,
			RetryBackoff: selection.RetryBackoff,
		})
	}
	var agent runtime.AgentRuntime
	var process *managedSidecar
	piMode := strings.ToLower(strings.TrimSpace(cfg.Runtime.PiMode))
	if piMode == "" { piMode = "auto" }
	if piMode == "managed" || piMode == "local" { piMode = "manual" }
	piStatus := api.PiRuntimeStatus{ConfiguredMode: piMode, EffectiveMode: "deterministic", State: "fallback", Reason: "Pi sidecar is not configured"}
	var sidecar *runtime.SidecarRuntime
	endpoint := strings.TrimSpace(cfg.Runtime.PiEndpoint)
	command := strings.TrimSpace(cfg.Runtime.PiCommand)
	args := append([]string(nil), cfg.Runtime.PiArgs...)
	startManaged := piMode == "manual"
	if piMode == "auto" {
		if candidate, ok := piagent.FirstSidecar(ctx); ok {
			command, startManaged = candidate.Path, true
			piStatus.Command, piStatus.State, piStatus.Reason = candidate.Path, "starting", "discovered sidecar command"
		} else {
			piStatus.Reason = "no sidecar-capable pi command found on PATH; using deterministic runtime"
		}
	}
	if startManaged {
		if endpoint == "" { endpoint = "http://127.0.0.1:8787" }
		process, err = startManagedSidecar(command, args, endpoint)
		if err != nil {
			if piMode != "auto" { return nil, err }
			process = nil
			piStatus.State, piStatus.EffectiveMode, piStatus.Reason = "fallback", "deterministic", "discovered sidecar could not be started: " + err.Error()
		} else {
			piStatus.Command, piStatus.Args, piStatus.Endpoint = command, append([]string(nil), args...), endpoint
			piStatus.EffectiveMode = piMode
			sidecar, err = runtime.NewSidecarRuntimeWithConfig(runtime.SidecarRuntimeConfig{Endpoint: endpoint, Store: store, CancelTimeout: cfg.Runtime.PiCancelTimeout})
			if err != nil {
				_ = process.Close(); process = nil
				if piMode != "auto" { return nil, err }
				piStatus.State, piStatus.EffectiveMode, piStatus.Reason = "fallback", "deterministic", "discovered sidecar endpoint is invalid; using deterministic runtime"
			} else { agent = sidecar }
		}
	}
	if piMode == "external" {
		if endpoint == "" { return nil, fmt.Errorf("pi sidecar endpoint is required for external mode") }
		sidecar, err = runtime.NewSidecarRuntimeWithConfig(runtime.SidecarRuntimeConfig{Endpoint: endpoint, Store: store, CancelTimeout: cfg.Runtime.PiCancelTimeout})
		if err != nil { return nil, err }
		piStatus.EffectiveMode, piStatus.State, piStatus.Endpoint, piStatus.Reason = "external", "configured", endpoint, "using externally managed sidecar"
		agent = sidecar
	}
	if agent == nil {
		provider := runtime.NewProviderRouter(cfg.Runtime.DefaultProvider, providers)
		agent = runtime.NewDeterministicRuntimeWithTimeout(provider, store, cfg.Runtime.MaxConcurrency, cfg.Runtime.DefaultTimeout)
		piStatus.EffectiveMode = "deterministic"
	}
	serverAPI := api.NewServer(cfg, agent, store, attachmentStore)
	serverAPI.SetPiRuntimeStatus(piStatus)
	server := &http.Server{
		Addr:         cfg.Server.Addr,
		Handler:      serverAPI,
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
		IdleTimeout:  cfg.Server.IdleTimeout,
	}
	// All dependencies have been opened and migrated at this point. The
	// listener is still created by the caller so bind failures are reported
	// before the desktop window or headless process starts.
	ready := true
	var readyStop context.CancelFunc
	if sidecar, ok := agent.(*runtime.SidecarRuntime); ok {
		probeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		ready = waitSidecarReady(probeCtx, sidecar)
		cancel()
		if !ready {
			watchCtx, stop := context.WithCancel(context.Background())
			readyStop = stop
			go watchSidecarReady(watchCtx, serverAPI, sidecar)
		}
	}
	serverAPI.SetReady(ready)
	closeStore = false
	return &Components{Store: store, Attachments: attachmentStore, Runtime: agent, API: serverAPI, HTTP: server, process: process, readyStop: readyStop}, nil
}

func waitSidecarReady(ctx context.Context, sidecar *runtime.SidecarRuntime) bool {
	for {
		if sidecar.Health(ctx) == nil { return true }
		select {
		case <-ctx.Done(): return false
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func watchSidecarReady(ctx context.Context, serverAPI *api.Server, sidecar *runtime.SidecarRuntime) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := sidecar.Health(probeCtx)
		cancel()
		if err == nil { serverAPI.SetReady(true); return }
		select {
		case <-ctx.Done(): return
		case <-ticker.C:
		}
	}
}

type managedSidecar struct {
	cmd  *exec.Cmd
	done chan struct{}
	once sync.Once
}

func startManagedSidecar(command string, args []string, endpoint string) (*managedSidecar, error) {
	command = strings.TrimSpace(command)
	if command == "" { return nil, errors.New("piCommand is required for managed sidecar") }
	if endpoint == "" { endpoint = "http://127.0.0.1:8787" }
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") { return nil, errors.New("invalid managed sidecar endpoint") }
	host, port := parsed.Hostname(), parsed.Port()
	if host == "" { host = "127.0.0.1" }
	if port == "" { port = "8787" }
	cmd := exec.Command(command, args...)
	cmd.Env = append(os.Environ(), "PI_SIDECAR_HOST="+host, "PI_SIDECAR_PORT="+port)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil { return nil, fmt.Errorf("start pi sidecar: %w", err) }
	managed := &managedSidecar{cmd: cmd, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(managed.done) }()
	return managed, nil
}

func (p *managedSidecar) Close() error {
	if p == nil || p.cmd == nil || p.cmd.Process == nil { return nil }
	var result error
	p.once.Do(func() {
		_ = p.cmd.Process.Signal(os.Interrupt)
		select {
		case <-p.done:
		case <-time.After(2 * time.Second):
			result = p.cmd.Process.Kill()
			<-p.done
		}
	})
	return result
}

func (c *Components) Close() error {
	if c == nil {
		return nil
	}
	if c.readyStop != nil { c.readyStop() }
	if closer, ok := c.Runtime.(interface{ Close() }); ok { closer.Close() }
	if c.process != nil { _ = c.process.Close() }
	if c.Store != nil {
		return c.Store.Close()
	}
	return nil
}
