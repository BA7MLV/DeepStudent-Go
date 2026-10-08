package runtime

// SiliconFlow is an OpenAI-compatible provider adapter. It intentionally
// accepts an environment-variable name rather than a key value so credentials
// never enter config files, request models, event payloads, or errors.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const DefaultSiliconFlowBaseURL = "https://api.siliconflow.cn/v1"

type SiliconFlowConfig struct {
	Name        string
	BaseURL     string
	APIKeyEnv   string
	Model       string
	Timeout     time.Duration
	MaxRetries  int
	RetryBackoff time.Duration
	HTTPClient   *http.Client
	LookupEnv    func(string) (string, bool)
}

type SiliconFlowProvider struct {
	name        string
	baseURL     string
	apiKeyEnv   string
	defaultModel string
	timeout     time.Duration
	maxRetries  int
	backoff     time.Duration
	client      *http.Client
	lookup      func(string) (string, bool)
}

func NewSiliconFlowProvider(cfg SiliconFlowConfig) *SiliconFlowProvider {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	keyEnv := strings.TrimSpace(cfg.APIKeyEnv)
	if keyEnv == "" {
		keyEnv = "SILICONFLOW_API_KEY"
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	backoff := cfg.RetryBackoff
	if backoff <= 0 {
		backoff = 250 * time.Millisecond
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 0
	}
	lookup := cfg.LookupEnv
	if lookup == nil {
		lookup = os.LookupEnv
	}
	name := strings.TrimSpace(cfg.Name)
	if name == "" {
		name = "siliconflow"
	}
	// Only the built-in SiliconFlow profile has a safe default endpoint. A
	// custom/deepseek profile with an empty endpoint must fail explicitly rather
	// than silently sending credentials to SiliconFlow.
	if base == "" && name == "siliconflow" {
		base = DefaultSiliconFlowBaseURL
	}
	return &SiliconFlowProvider{name: name, baseURL: base, apiKeyEnv: keyEnv, defaultModel: strings.TrimSpace(cfg.Model), timeout: timeout, maxRetries: cfg.MaxRetries, backoff: backoff, client: client, lookup: lookup}
}

func (p *SiliconFlowProvider) Name() string { return p.name }

// TestOpenAICompatible checks that a provider endpoint is reachable and the
// configured environment credential is accepted. It performs only a GET
// /models request and never returns response bodies or credential values.
func TestOpenAICompatible(ctx context.Context, baseURL, apiKeyEnv string, lookup func(string) (string, bool), timeout time.Duration) error {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return errors.New("provider endpoint is not configured")
	}
	if lookup == nil {
		lookup = os.LookupEnv
	}
	if ctx == nil {
		ctx = context.Background()
	}
	apiKeyEnv = strings.TrimSpace(apiKeyEnv)
	if apiKeyEnv == "" {
		return errors.New("provider credential environment variable is not configured")
	}
	key, ok := lookup(apiKeyEnv)
	if !ok || strings.TrimSpace(key) == "" {
		return fmt.Errorf("credential environment variable %s is empty", apiKeyEnv)
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		return errors.New("provider endpoint is invalid")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	response, err := (&http.Client{}).Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return errors.New("provider endpoint is unreachable")
	}
	defer response.Body.Close()
	_, _ = io.CopyN(io.Discard, response.Body, 4096)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("provider returned HTTP %d", response.StatusCode)
	}
	return nil
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type siliconFlowRequest struct {
	Model       string          `json:"model"`
	Messages    []openAIMessage `json:"messages"`
	Stream      bool            `json:"stream"`
	MaxTokens   int             `json:"max_tokens,omitempty"`
	Temperature float64         `json:"temperature,omitempty"`
}

type siliconFlowChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}

func (p *SiliconFlowProvider) Stream(ctx context.Context, request ModelRequest, emit func(StreamEvent) error) error {
	if emit == nil {
		return errors.New("event sink is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	keyEnv := strings.TrimSpace(request.APIKeyEnv)
	if keyEnv == "" {
		keyEnv = p.apiKeyEnv
	}
	key, ok := p.lookup(keyEnv)
	if !ok || strings.TrimSpace(key) == "" {
		return fmt.Errorf("provider %s is not configured: credential environment variable %s is empty", p.Name(), keyEnv)
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = p.defaultModel
	}
	if model == "" {
		return errors.New("siliconflow model is required")
	}
	messages := make([]openAIMessage, 0, len(request.Messages)+1)
	for _, message := range request.Messages {
		role := strings.TrimSpace(message.Role)
		if role == "" {
			role = "user"
		}
		messages = append(messages, openAIMessage{Role: role, Content: message.Content})
	}
	if len(messages) == 0 && strings.TrimSpace(request.Prompt) != "" {
		messages = append(messages, openAIMessage{Role: "user", Content: request.Prompt})
	}
	if len(messages) == 0 {
		return errors.New("prompt or messages are required")
	}
	payload := siliconFlowRequest{Model: model, Messages: messages, Stream: true, MaxTokens: request.MaxTokens, Temperature: request.Temperature}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode provider request: %w", err)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(request.BaseURL), "/")
	if baseURL == "" {
		baseURL = p.baseURL
	}
	endpoint := baseURL + "/chat/completions"
	for attempt := 0; attempt <= p.maxRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		attemptCtx, cancel := context.WithTimeout(ctx, p.timeout)
		response, retry, err := p.do(attemptCtx, endpoint, key, body)
		if err == nil {
			streamErr := p.readStream(attemptCtx, response.Body, emit)
			cancel()
			return streamErr
		}
		cancel()
		if !retry || attempt == p.maxRetries {
			return err
		}
		delay := p.backoff * time.Duration(1<<min(attempt, 4))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return errors.New("provider request failed")
}

// do returns a response only for a successful status. The response body is
// always closed on errors, and provider response content is kept out of errors
// to avoid accidentally exposing credentials or user prompts.
func (p *SiliconFlowProvider) do(ctx context.Context, endpoint, key string, body []byte) (*http.Response, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("build provider request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	response, err := p.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, false, err
		}
		return nil, true, fmt.Errorf("provider request failed")
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response, false, nil
	}
	_, _ = io.CopyN(io.Discard, response.Body, 4096)
	_ = response.Body.Close()
	retry := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
	return nil, retry, fmt.Errorf("provider returned HTTP %d", response.StatusCode)
}

func (p *SiliconFlowProvider) readStream(ctx context.Context, body io.ReadCloser, emit func(StreamEvent) error) error {
	defer body.Close()
	scanner := bufio.NewScanner(body)
	// Model output can contain long lines. Keep a bounded but generous limit.
	scanner.Buffer(make([]byte, 16*1024), 2<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			return nil
		}
		var chunk siliconFlowChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return errors.New("provider returned invalid stream data")
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]
		text := choice.Delta.Content
		if text == "" {
			text = choice.Message.Content
		}
		if text == "" {
			continue
		}
		if err := emit(StreamEvent{Type: EventTextDelta, Delta: text, Text: text}); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return errors.New("provider stream failed")
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
