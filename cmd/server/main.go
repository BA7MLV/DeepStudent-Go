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
	provider := runtime.NewDeterministicProvider()
	agent := runtime.NewDeterministicRuntime(provider, store, cfg.Runtime.MaxConcurrency)
	server := &http.Server{
		Addr:         cfg.Server.Addr,
		Handler:      api.NewServer(cfg, agent),
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
