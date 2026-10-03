// deepstudent-server starts the local HTTP/SSE runtime.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/api"
	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/storage"
)

func main() {
	cfg, err := config.Load("")
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	store, err := storage.OpenSQLite(ctx, cfg.Storage.SQLitePath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	if _, err := storage.NewAttachmentStore(store, cfg.Storage.BlobRoot, attachments.Policy{MaxBytes: cfg.Storage.AttachmentMaxBytes, AllowedMIMEs: cfg.Storage.AttachmentAllowedMIMEs}); err != nil {
		log.Fatal(err)
	}
	providers := map[string]runtime.ModelProvider{"deterministic": runtime.NewDeterministicProvider()}
	for name, profile := range cfg.Providers {
		if name == "deterministic" {
			continue
		}
		selection, resolveErr := cfg.ResolveModel(name, "")
		if resolveErr != nil {
			log.Printf("provider %s disabled: invalid model profile", name)
			continue
		}
		// SiliconFlow's OpenAI-compatible adapter also covers DeepSeek and
		// explicitly configured OpenAI-compatible endpoints. It reads the
		// credential only at request time from the named environment variable.
		providers[name] = runtime.NewSiliconFlowProvider(runtime.SiliconFlowConfig{
			Name: name, BaseURL: selection.BaseURL, APIKeyEnv: profile.APIKeyEnv,
			Model: selection.Model, Timeout: selection.Timeout, MaxRetries: selection.MaxRetries,
			RetryBackoff: selection.RetryBackoff,
		})
	}
	provider := runtime.NewProviderRouter(cfg.Runtime.DefaultProvider, providers)
	agent := runtime.NewDeterministicRuntimeWithTimeout(provider, store, cfg.Runtime.MaxConcurrency, cfg.Runtime.DefaultTimeout)
	defer agent.Close()
	server := &http.Server{
		Addr:         cfg.Server.Addr,
		Handler:      api.NewServer(cfg, agent, store),
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
		IdleTimeout:  cfg.Server.IdleTimeout,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("deepstudent server listening on %s", cfg.Server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
