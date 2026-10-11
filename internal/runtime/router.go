package runtime

import (
	"context"
	"errors"
)

// ProviderRouter keeps provider selection in the runtime seam. The HTTP layer
// only carries the provider/model profile; it never receives credentials.
type ProviderRouter struct {
	providers map[string]ModelProvider
	defaultName string
}

func NewProviderRouter(defaultName string, providers map[string]ModelProvider) *ProviderRouter {
	copy := make(map[string]ModelProvider, len(providers))
	for name, provider := range providers {
		if provider != nil {
			copy[name] = provider
		}
	}
	return &ProviderRouter{providers: copy, defaultName: defaultName}
}

func (r *ProviderRouter) Name() string { return "router" }

func (r *ProviderRouter) Stream(ctx context.Context, request ModelRequest, emit func(StreamEvent) error) error {
	name := request.Provider
	if name == "" {
		name = r.defaultName
	}
	provider, ok := r.providers[name]
	if !ok {
		return errors.New("model provider is not configured")
	}
	return provider.Stream(ctx, request, emit)
}
