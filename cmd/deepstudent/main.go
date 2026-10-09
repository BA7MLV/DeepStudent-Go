package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
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
	// MyGo serves the embedded React document from this custom origin. Keep
	// the origin desktop-only so the shared server defaults remain strict.
	// MyGo 0.3.0 uses a custom origin on macOS/Linux and maps it to
	// http://mygo.localhost on Windows WebView2. Allow both so the same
	// embedded frontend can reach the Go runtime on every desktop target.
	cfg.Server.CORSAllowlist = append(cfg.Server.CORSAllowlist, "mygo://localhost", "http://mygo.localhost")
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
	defer shutdownDesktopHTTP(components.HTTP, listener, serveDone)

	mygo.Bind(runtime.NewHealthService())

	mygo.App.WhenReady(func() {
		// The native shell is the default desktop surface on macOS, where the
		// MyGo window provides the actual app chrome and input controls. Keep an
		// explicit opt-out for the WebView while retaining the opt-in switch on
		// other platforms so headless and preview builds stay unchanged.
		nativeMode := nativeShellEnabled(goruntime.GOOS, os.Getenv("DEEPSTUDENT_NATIVE_SHELL"))
		// The embedded MyGo document is served from mygo://localhost. Pass the
		// actual loopback listener to the React shell so its Go adapter can send
		// POST /runs and follow the SSE stream instead of resolving /api/v1 on the
		// custom mygo:// origin.
		webURL := desktopWebURL(listener)
		var shell *nativeShell
		var window *mygo.Window
		var chatWindow *mygo.Window
		if nativeMode {
			shell = newNativeShell(nativeRuntimeBaseURL(listener))
			go shell.hydrateSession()
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
				Title: "DeepStudent Chat", URL: webURL + "&view=chat-v2&onboarding=skip", Parent: window, Width: 1100, Height: 760, MinWidth: 760, MinHeight: 520, TitleBarStyle: mygo.TitleBarHidden, TitleBarHeight: 44, BackgroundColor: "#f7f7f5", StateKey: "chat-web",
			})
			child := chatWindow
			child.OnClosed(func() { if chatWindow == child { chatWindow = nil } })
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
			opts.URL = webURL
		}
		window = mygo.NewWindow(opts)
		if shell != nil {
			shell.window = window
			window.OnFileDrop(func(event *mygo.FileDropEvent) {
				for _, path := range event.Paths {
					go shell.attachFile(path)
					break
				}
			})
			shell.invalidate = window.Invalidate
		}
	})

	return mygo.App.Run()
}

// nativeShellEnabled chooses the desktop surface without making a platform
// build depend on an environment variable being present. macOS uses the
// native MyGo shell by default; DEEPSTUDENT_NATIVE_SHELL=0 (or false/off/no)
// opts out. On other platforms, the shell remains opt-in for now.
func nativeShellEnabled(goos, setting string) bool {
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return goos == "darwin"
	}
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

// shutdownDesktopHTTP closes the listener before releasing the runtime/store.
// Waiting for Serve to return prevents a late handler from racing teardown.
func shutdownDesktopHTTP(server *http.Server, listener net.Listener, serveDone <-chan error) {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if server != nil {
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("deepstudent HTTP shutdown failed: %v", err)
			_ = server.Close()
		}
	}
	if listener != nil {
		_ = listener.Close()
	}
	if serveDone == nil {
		return
	}
	wait := time.NewTimer(time.Second)
	defer wait.Stop()
	select {
	case serveErr := <-serveDone:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("deepstudent HTTP server stopped: %v", serveErr)
		}
	case <-wait.C:
		log.Printf("deepstudent HTTP server did not stop before shutdown deadline")
	}
}

// desktopWebURL points the embedded React document at the loopback API while
// preserving the mygo://localhost origin used to load frontend/dist.
func desktopWebURL(listener net.Listener) string {
	return "/?runtime=" + url.QueryEscape(nativeRuntimeBaseURL(listener)+"/api/v1")
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
