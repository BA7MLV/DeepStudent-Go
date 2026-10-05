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
	"strconv"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	"github.com/BA7MLV/DeepStudent-Go/internal/serverapp"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
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
		// The native shell is now the default desktop surface. Set
		// DEEPSTUDENT_NATIVE_SHELL=1 enables the native UI experiment; the
		// default remains the complete React WebView experience.
		nativeMode := os.Getenv("DEEPSTUDENT_NATIVE_SHELL") == "1"
		var shell *nativeShell
		var window *mygo.Window
		var chatWindow *mygo.Window
		if nativeMode {
			shell = newNativeShell(nativeRuntimeBaseURL(listener))
		}
		installNativeMenu(func(command string) {
			if nativeMode && shell != nil {
				switch command {
				case "settings":
					shell.selected = "settings"
				case "new-session":
					shell.selected = "chat"
				case "learning-hub":
					shell.selected = "resources"
				case "toggle-theme":
					shell.dark = !shell.dark
				}
				if window != nil {
					window.Invalidate()
				}
				return
			}
			if window == nil || window.Page() == nil {
				return
			}
			_, _ = window.Page().Eval("window.dispatchEvent(new CustomEvent('deepstudent:command',{detail:{command:" + strconv.Quote(command) + "}}))")
		})
		openChat := func() {
			if chatWindow != nil {
				chatWindow.Show()
				chatWindow.Focus()
				return
			}
			chatWindow = mygo.NewWindow(mygo.WindowOptions{
				Title: "DeepStudent Chat", URL: "/", Parent: window, Width: 1100, Height: 760, MinWidth: 760, MinHeight: 520, TitleBarStyle: mygo.TitleBarHidden, TitleBarHeight: 44, BackgroundColor: "#f7f7f5", StateKey: "chat-web",
			})
		}
		if shell != nil {
			shell.openChat = openChat
		}
		opts := mygo.WindowOptions{
			Title:           "DeepStudent Go",
			TitleBarStyle:   mygo.TitleBarHidden,
			TitleBarHeight:  44,
			BackgroundColor: "#f7f7f5",
		}
		if nativeMode {
			opts.Content = ui.View(shell.view)
			opts.Width = 1200
			opts.Height = 780
			opts.MinWidth = 860
			opts.MinHeight = 560
			opts.StateKey = "native-main"
		} else {
			opts.URL = "/"
		}
		window = mygo.NewWindow(opts)
		if shell != nil {
			shell.invalidate = window.Invalidate
		}
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

func nativeRuntimeBaseURL(listener net.Listener) string {
	host, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil || port == "" {
		return "http://127.0.0.1:8080"
	}
	if host == "" || host == "::" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// installNativeMenu keeps desktop-level actions in the MyGo native menu instead
// of duplicating them as web-only affordances. The page receives a small,
// explicit command event for actions that belong to the React workspace.
func installNativeMenu(dispatch func(string)) {
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Label: "File", Submenu: []*mygo.MenuItem{
			{Label: "New Session", Accelerator: "CmdOrCtrl+N", Click: func(*mygo.MenuItem, *mygo.Window) { dispatch("new-session") }},
			mygo.Separator(),
			{Role: mygo.RoleClose},
		}},
		{Label: "View", Submenu: []*mygo.MenuItem{
			{Label: "Learning Resources", Accelerator: "CmdOrCtrl+Shift+L", Click: func(*mygo.MenuItem, *mygo.Window) { dispatch("learning-hub") }},
			{Label: "Settings", Accelerator: "CmdOrCtrl+,", Click: func(*mygo.MenuItem, *mygo.Window) { dispatch("settings") }},
			{Label: "Toggle Theme", Click: func(*mygo.MenuItem, *mygo.Window) { dispatch("toggle-theme") }},
			mygo.Separator(),
			{Role: mygo.RoleReload},
		}},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleWindowMenu},
	}))
}
