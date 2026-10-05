package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/serverapp"
	"github.com/egoist/mygo"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := config.Load("")
	if err != nil {
		return err
	}
	cfg, err = resolveDesktopStoragePaths(cfg)
	if err != nil {
		return err
	}
	components, err := serverapp.New(context.Background(), cfg)
	if err != nil {
		return err
	}
	defer components.Close()

	// Bind before starting MyGo so a port collision fails deterministically
	// instead of leaving a desktop window whose chat runtime is unreachable.
	listener, err := net.Listen("tcp", cfg.Server.Addr)
	if err != nil {
		return err
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- components.HTTP.Serve(listener)
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = components.HTTP.Shutdown(shutdownCtx)
		_ = listener.Close()
		select {
		case serveErr := <-serveDone:
			if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				log.Printf("deepstudent HTTP server stopped: %v", serveErr)
			}
		default:
		}
	}()

	mygo.Bind(runtime.NewHealthService())

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:         "DeepStudent Go",
			URL:           "/",
			TitleBarStyle: mygo.TitleBarHidden,
		})
	})

	return mygo.App.Run()
}

// resolveDesktopStoragePaths keeps a Finder-launched app from trying to create
// relative data paths in the process working directory (often `/` on macOS).
// Headless/server commands retain their existing relative-path behavior.
func resolveDesktopStoragePaths(cfg config.Config) (config.Config, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return cfg, fmt.Errorf("resolve desktop config directory: %w", err)
	}
	root := filepath.Join(base, "DeepStudent Go")
	if !filepath.IsAbs(cfg.Storage.SQLitePath) {
		cfg.Storage.SQLitePath = filepath.Join(root, cfg.Storage.SQLitePath)
	}
	if !filepath.IsAbs(cfg.Storage.BlobRoot) {
		cfg.Storage.BlobRoot = filepath.Join(root, cfg.Storage.BlobRoot)
	}
	return cfg, nil
}
