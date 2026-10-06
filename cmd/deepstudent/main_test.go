package main

import (
	"net"
	"net/url"
	"testing"
)

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
