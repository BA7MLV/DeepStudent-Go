package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// MemorySessionStore mirrors the append-only contract without requiring a
// database. It is used by deterministic tests and safe local development.
type MemorySessionStore struct {
	mu       sync.Mutex
	sessions map[string]Session
	events   map[string][]SessionEvent
	messages map[string][]Message
}

func NewMemorySessionStore() *MemorySessionStore {
	return &MemorySessionStore{sessions: make(map[string]Session), events: make(map[string][]SessionEvent), messages: make(map[string][]Message)}
}

func (s *MemorySessionStore) CreateSession(ctx context.Context, sessionID string) error {
	_, err := s.CreateSessionWithTitle(ctx, Session{ID: sessionID})
	return err
}

func (s *MemorySessionStore) CreateSessionWithTitle(_ context.Context, session Session) (Session, error) {
	if strings.TrimSpace(session.ID) == "" {
		return Session{}, errors.New("session id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.sessions[session.ID]; ok {
		if session.Title != "" && existing.Title != session.Title {
			existing.Title = session.Title
			existing.UpdatedAt = time.Now().UTC()
			s.sessions[session.ID] = existing
		}
		return existing, nil
	}
	now := time.Now().UTC()
	if session.CreatedAt.IsZero() {
		session.CreatedAt = now
	}
	if session.UpdatedAt.IsZero() {
		session.UpdatedAt = session.CreatedAt
	}
	s.sessions[session.ID] = session
	return session, nil
}

func (s *MemorySessionStore) GetSession(_ context.Context, sessionID string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[sessionID]
	if !ok {
		return Session{}, errors.New("session not found")
	}
	return session, nil
}

func (s *MemorySessionStore) ListSessions(_ context.Context, limit, offset int) ([]Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		result = append(result, session)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt.After(result[j].UpdatedAt) })
	if offset < 0 {
		offset = 0
	}
	if offset >= len(result) {
		return []Session{}, nil
	}
	result = result[offset:]
	if limit > 0 && limit < len(result) {
		result = result[:limit]
	}
	return result, nil
}

func (s *MemorySessionStore) AppendEvent(_ context.Context, event SessionEvent) (SessionEvent, error) {
	if strings.TrimSpace(event.SessionID) == "" {
		return SessionEvent{}, errors.New("session id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[event.SessionID]; !ok {
		now := time.Now().UTC()
		s.sessions[event.SessionID] = Session{ID: event.SessionID, CreatedAt: now, UpdatedAt: now}
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	if event.Payload == nil {
		event.Payload = json.RawMessage("null")
	}
	items := s.events[event.SessionID]
	event.Sequence = int64(len(items) + 1)
	s.events[event.SessionID] = append(items, event)
	session := s.sessions[event.SessionID]
	session.UpdatedAt = event.CreatedAt
	s.sessions[event.SessionID] = session
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

func (s *MemorySessionStore) AppendMessage(_ context.Context, message Message) (Message, error) {
	if strings.TrimSpace(message.SessionID) == "" {
		return Message{}, errors.New("session id is required")
	}
	if strings.TrimSpace(message.Role) == "" {
		return Message{}, errors.New("message role is required")
	}
	if message.Content == "" {
		return Message{}, errors.New("message content is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Message IDs are the client idempotency key. Keep the in-memory store's
	// semantics identical to SQLite so retries cannot create duplicate user or
	// assistant messages during local development and tests.
	if message.ID != "" {
		for _, items := range s.messages {
			for _, existing := range items {
				if existing.ID != message.ID {
					continue
				}
				if existing.SessionID != message.SessionID || existing.Role != message.Role || existing.Content != message.Content {
					return Message{}, fmt.Errorf("%w: message %q does not match the original", ErrMessageConflict, message.ID)
				}
				if existing.RunID == "" && message.RunID != "" {
					// A previous request may have persisted the message before the
					// runtime was started. Reserve the run id on retry.
					existing.RunID = message.RunID
					for index := range items {
						if items[index].ID == existing.ID {
							items[index] = existing
							break
						}
					}
					s.messages[existing.SessionID] = items
				}
				return existing, nil
			}
		}
	}
	if _, ok := s.sessions[message.SessionID]; !ok {
		now := time.Now().UTC()
		s.sessions[message.SessionID] = Session{ID: message.SessionID, CreatedAt: now, UpdatedAt: now}
	}
	if message.ID == "" {
		message.ID = newID("msg")
	}
	if message.CreatedAt.IsZero() {
		message.CreatedAt = time.Now().UTC()
	}
	s.messages[message.SessionID] = append(s.messages[message.SessionID], message)
	session := s.sessions[message.SessionID]
	session.UpdatedAt = message.CreatedAt
	s.sessions[message.SessionID] = session
	return message, nil
}

func (s *MemorySessionStore) GetMessage(_ context.Context, messageID string) (Message, error) {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return Message{}, errors.New("message id is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, items := range s.messages {
		for _, message := range items {
			if message.ID == messageID {
				return message, nil
			}
		}
	}
	return Message{}, fmt.Errorf("message %q not found", messageID)
}

func (s *MemorySessionStore) Messages(_ context.Context, sessionID string, after time.Time) ([]Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := s.messages[sessionID]
	result := make([]Message, 0, len(items))
	for _, item := range items {
		if after.IsZero() || item.CreatedAt.After(after) {
			result = append(result, item)
		}
	}
	return result, nil
}
