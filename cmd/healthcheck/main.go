// healthcheck is the tiny probe used by the container image. It is kept as a
// separate static binary because the distroless runtime image does not ship a
// shell, curl, or wget.
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	defaultURL   = "http://127.0.0.1:8080/readyz"
	probeTimeout = 2 * time.Second
	healthURL    = "DEEPSTUDENT_HEALTHCHECK_URL"
)

func main() {
	url := strings.TrimSpace(os.Getenv(healthURL))
	if url == "" {
		url = defaultURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	if err := probe(ctx, http.DefaultClient, url); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func probe(ctx context.Context, client *http.Client, url string) error {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("healthcheck request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("healthcheck request: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("healthcheck returned HTTP %d", resp.StatusCode)
	}
	return nil
}
