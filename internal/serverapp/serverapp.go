// Package serverapp builds the local HTTP/SSE runtime and owns its resources.
// Both the headless server and the MyGo desktop use this package so they have
// identical provider, SQLite, attachment, and shutdown semantics.
package serverapp

import (
	"context"
	"net/http"

	"github.com/BA7MLV/DeepStudent-Go/internal/api"
	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/storage"
)

// Components contains the resources that must live at least as long as the
// HTTP server. Call Close after the listener has stopped accepting requests.
type Components struct {
	Store      *storage.SQLiteStore
	Attachments *storage.AttachmentStore
	Runtime    *runtime.DeterministicRuntime
	API        *api.Server
	HTTP       *http.Server
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
	provider := runtime.NewProviderRouter(cfg.Runtime.DefaultProvider, providers)
	agent := runtime.NewDeterministicRuntimeWithTimeout(provider, store, cfg.Runtime.MaxConcurrency, cfg.Runtime.DefaultTimeout)
	serverAPI := api.NewServer(cfg, agent, store, attachmentStore)
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
	serverAPI.SetReady(true)
	closeStore = false
	return &Components{Store: store, Attachments: attachmentStore, Runtime: agent, API: serverAPI, HTTP: server}, nil
}

func (c *Components) Close() error {
	if c == nil {
		return nil
	}
	if c.Runtime != nil {
		c.Runtime.Close()
	}
	if c.Store != nil {
		return c.Store.Close()
	}
	return nil
}
