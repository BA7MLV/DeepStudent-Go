package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

// MemorySessionStore mirrors the append-only contract without requiring a
// database. It is used by deterministic tests and safe local development.
type MemorySessionStore struct {
	mu       sync.Mutex
	sessions map[string]struct{}
	events   map[string][]SessionEvent
}

func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{sessions: make(map[string]struct{}), events: make(map[string][]SessionEvent)}
}

func (s *MemorySessionStore) CreateSession(_ context.Context, sessionID string) error {
	if sessionID == "" {
		return errors.New("session id is required")
	}
	s.mu.Lock()
	s.sessions[sessionID] = struct{}{}
	s.mu.Unlock()
	return nil
}

func (s *MemorySessionStore) AppendEvent(_ context.Context, event SessionEvent) (SessionEvent, error) {
	if event.SessionID == "" {
		return SessionEvent{}, errors.New("session id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	if event.Payload == nil {
		event.Payload = json.RawMessage("null")
	}
	items := s.events[event.SessionID]
	event.Sequence = int64(len(items) + 1)
	s.events[event.SessionID] = append(items, event)
	s.sessions[event.SessionID] = struct{}{}
	return event, nil
}

func (s *MemorySessionStore) Events(_ context.Context, sessionID string, afterSequence int64) ([]SessionEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := s.events[sessionID]
	result := make([]SessionEvent, 0, len(items))
	for _, item := range items {
		if item.Sequence > afterSequence {
			result = append(result, item)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Sequence < result[j].Sequence })
	return result, nil
}
