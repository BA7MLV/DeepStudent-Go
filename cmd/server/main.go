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

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/serverapp"
)

func main() {
	cfg, err := config.Load("")
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	components, err := serverapp.New(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer components.Close()
	server := components.HTTP

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	go func() {
		<-stop
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			// A long-lived SSE client can outlive the graceful shutdown window.
			// The runtime and SQLite store are still closed by the deferred cleanup
			// below, so do not leave the process running after the deadline.
			log.Printf("deepstudent graceful shutdown: %v", err)
			_ = server.Close()
		}
	}()
	log.Printf("deepstudent server listening on %s", cfg.Server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
