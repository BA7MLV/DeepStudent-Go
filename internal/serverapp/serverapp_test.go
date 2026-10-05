package serverapp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/api"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
)

func TestWatchSidecarReadyRecoversAfterDelayedStartup(t *testing.T) {
	var probes atomic.Int32
	sidecarServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/healthz" {
			http.NotFound(w, req)
			return
		}
		if probes.Add(1) < 3 {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer sidecarServer.Close()
	sidecar, err := runtime.NewSidecarRuntime(sidecarServer.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sidecar.Close()
	apiServer := api.NewServer(config.Defaults(), runtime.NewDeterministicRuntime(nil, nil, 1))
	apiServer.SetReady(false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go watchSidecarReady(ctx, apiServer, sidecar)
	deadline := time.NewTimer(4 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for !apiServer.Ready() {
		select {
		case <-deadline.C:
			t.Fatalf("sidecar readiness did not recover after %d probes", probes.Load())
		case <-ticker.C:
		}
	}
	if probes.Load() < 3 {
		t.Fatalf("readiness recovered without retrying probes: %d", probes.Load())
	}
}

