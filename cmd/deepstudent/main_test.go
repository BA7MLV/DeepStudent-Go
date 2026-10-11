package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestNativeShellEnabledDefaultsAndOverrides(t *testing.T) {
	tests := []struct {
		name, goos, setting string
		want                bool
	}{
		{name: "macOS defaults to native", goos: "darwin", want: true},
		{name: "other platforms stay webview by default", goos: "linux", want: false},
		{name: "explicit opt in", goos: "linux", setting: "1", want: true},
		{name: "explicit opt out", goos: "darwin", setting: "0", want: false},
		{name: "text opt out", goos: "darwin", setting: " off ", want: false},
		{name: "text opt in", goos: "linux", setting: "TRUE", want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeShellEnabled(test.goos, test.setting); got != test.want {
				t.Fatalf("nativeShellEnabled(%q, %q) = %t, want %t", test.goos, test.setting, got, test.want)
			}
		})
	}
}

func TestWebViewDebugEnabledIsOptIn(t *testing.T) {
	for _, setting := range []string{"", "0", "false", " off ", "no"} {
		if webViewDebugEnabled(setting) {
			t.Fatalf("webViewDebugEnabled(%q) = true, want false", setting)
		}
	}
	for _, setting := range []string{"1", "true", "YES", " on "} {
		if !webViewDebugEnabled(setting) {
			t.Fatalf("webViewDebugEnabled(%q) = false, want true", setting)
		}
	}
}

func TestDesktopWebURLCarriesRuntimeAPI(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	parsed, err := url.Parse(desktopWebURL(listener))
	if err != nil {
		t.Fatal(err)
	}
	want := nativeRuntimeBaseURL(listener) + "/api/v1"
	if got := parsed.Query().Get("runtime"); got != want {
		t.Fatalf("runtime query = %q, want %q", got, want)
	}
}

func TestShutdownDesktopHTTPWaitsForServe(t *testing.T) {
	serveDone := make(chan error, 1)
	go func() { time.Sleep(20 * time.Millisecond); serveDone <- http.ErrServerClosed }()
	started := time.Now()
	shutdownDesktopHTTP(nil, nil, serveDone)
	if elapsed := time.Since(started); elapsed < 15*time.Millisecond {
		t.Fatalf("shutdown returned before Serve completed: %s", elapsed)
	}
}

func TestShutdownDesktopHTTPClosesListenerAndWaitsForServe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.NotFoundHandler()}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	shutdownDesktopHTTP(server, listener, serveDone)
	conn, dialErr := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond)
	if conn != nil {
		_ = conn.Close()
	}
	if dialErr == nil {
		t.Fatal("listener remained open after desktop shutdown")
	}
}

func TestNativeRunEventToolPayloads(t *testing.T) {
	var call nativeRunEvent
	if err := json.Unmarshal([]byte(`{"type":"tool.call","tool_call":{"id":"call-1","name":"clock","arguments":{"tz":"UTC"}}}`), &call); err != nil {
		t.Fatal(err)
	}
	id, name, args, ok := call.toolCall()
	if !ok || id != "call-1" || name != "clock" || args != `{"tz":"UTC"}` {
		t.Fatalf("tool call = %q %q %q %t", id, name, args, ok)
	}
	var result nativeRunEvent
	if err := json.Unmarshal([]byte(`{"type":"tool.result","metadata":{"tool_call_id":"call-1","tool_name":"clock","output":{"hour":12}}}`), &result); err != nil {
		t.Fatal(err)
	}
	id, name, output, failed, message, ok := result.toolResult()
	if !ok || id != "call-1" || name != "clock" || output != `{"hour":12}` || failed || message != "" {
		t.Fatalf("tool result = %q %q %q %t %q %t", id, name, output, failed, message, ok)
	}
}
