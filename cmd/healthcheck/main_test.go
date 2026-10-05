package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProbeAcceptsReadyResponse(t *testing.T) {
	requestOK := make(chan bool, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestOK <- r.Method == http.MethodGet && r.URL.Path == "/readyz"
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	if err := probe(context.Background(), server.Client(), server.URL+"/readyz"); err != nil {
		t.Fatalf("probe returned error: %v", err)
	}
	if !<-requestOK {
		t.Fatal("probe did not issue the expected GET /readyz request")
	}
}

func TestProbeRejectsNotReadyResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// The API returns 503 while storage/runtime initialization is incomplete.
		// A container should stay unhealthy until that state clears.
		//
		// Intentionally avoid writing a body; probe only needs the status code.
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	if err := probe(context.Background(), server.Client(), server.URL); err == nil {
		t.Fatal("probe accepted a 503 response")
	}
}
