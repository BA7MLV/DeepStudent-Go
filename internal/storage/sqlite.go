// Package storage provides the single-writer SQLite boundary.
package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	_ "modernc.org/sqlite"
)

const schemaVersion = 3

// SQLiteStore keeps one database writer and puts every append through a short
// transaction. WAL mode enables concurrent readers while preserving a simple
// local deployment model.
type SQLiteStore struct {
	db *sql.DB
}

func OpenSQLite(ctx context.Context, path string) (*SQLiteStore, error) {
	if path == "" {
		return nil, errors.New("sqlite path is required")
	}
	if path != ":memory:" {
		if dir := filepath.Dir(path); dir != "." {
			if err := os.MkdirAll(dir, 0o750); err != nil {
				return nil, fmt.Errorf("create sqlite directory: %w", err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// A single writer is deliberate: it avoids lock storms on low-memory local
	// installs. Read operations still use the same pool safely.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &SQLiteStore{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) DB() *sql.DB { return s.db }
func (s *SQLiteStore) Close() error { return s.db.Close() }

func (s *SQLiteStore) migrate(ctx context.Context) error {
	// journal_mode changes must run outside an explicit transaction in SQLite.
	for _, pragma := range []string{`PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`} {
		if _, err := s.db.ExecContext(ctx, pragma); err != nil {
			return fmt.Errorf("sqlite pragma: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("create migration table: %w", err)
	}
	var current int
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	migrations := map[int][]string{
		1: {
			`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, FOREIGN KEY(session_id) REFERENCES sessions(id))`,
			`CREATE TABLE IF NOT EXISTS session_events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, run_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, sequence), FOREIGN KEY(session_id) REFERENCES sessions(id))`,
			`CREATE TABLE IF NOT EXISTS provider_profiles (name TEXT PRIMARY KEY, base_url TEXT NOT NULL DEFAULT '', base_url_env TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '', max_tokens INTEGER NOT NULL DEFAULT 0, input_capabilities_json TEXT NOT NULL DEFAULT '[]', api_key_env TEXT NOT NULL DEFAULT '', timeout_ms INTEGER NOT NULL DEFAULT 0)`,
			`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		},
		2: {
			`ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
			`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id))`,
			`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)`,
			`CREATE INDEX IF NOT EXISTS idx_session_events_run ON session_events(run_id, sequence)`,
			`CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at, id)`,
			`CREATE INDEX IF NOT EXISTS idx_runs_session_created ON runs(session_id, created_at)`,
		},
		3: {
			`CREATE TABLE IF NOT EXISTS attachments (sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64), size INTEGER NOT NULL CHECK(size >= 0), mime TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', workspace_ref TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
			`CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at)`,
		},
	}
	for version := current + 1; version <= schemaVersion; version++ {
		statements := migrations[version]
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", version, err)
		}
		ok := false
		for _, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				// Version 1 databases created by an early prototype already had
				// sessions.title. Keep upgrades idempotent in that case.
				if version == 2 && strings.Contains(statement, "ADD COLUMN title") && strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
					continue
				}
				_ = tx.Rollback()
				return fmt.Errorf("migration %d statement: %w", version, err)
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`, version, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %d: %w", version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", version, err)
		}
		ok = true
		if !ok {
			return fmt.Errorf("migration %d did not complete", version)
		}
	}
	return nil
}

func (s *SQLiteStore) CreateSession(ctx context.Context, sessionID string) error {
	_, err := s.CreateSessionWithTitle(ctx, runtime.Session{ID: sessionID})
	return err
}

func (s *SQLiteStore) CreateSessionWithTitle(ctx context.Context, session runtime.Session) (runtime.Session, error) {
	if strings.TrimSpace(session.ID) == "" {
		return runtime.Session{}, errors.New("session id is required")
	}
	now := time.Now().UTC()
	if session.CreatedAt.IsZero() {
		session.CreatedAt = now
	}
	if session.UpdatedAt.IsZero() {
		session.UpdatedAt = session.CreatedAt
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END, updated_at = CASE WHEN excluded.title <> '' THEN excluded.updated_at ELSE sessions.updated_at END`, session.ID, session.Title, session.CreatedAt.UTC().Format(time.RFC3339Nano), session.UpdatedAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return runtime.Session{}, err
	}
	return s.GetSession(ctx, session.ID)
}

func (s *SQLiteStore) GetSession(ctx context.Context, sessionID string) (runtime.Session, error) {
	var session runtime.Session
	var created, updated string
	err := s.db.QueryRowContext(ctx, `SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?`, sessionID).Scan(&session.ID, &session.Title, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return runtime.Session{}, fmt.Errorf("session %q not found", sessionID)
	}
	if err != nil {
		return runtime.Session{}, err
	}
	session.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return runtime.Session{}, err
	}
	session.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated)
	return session, err
}

func (s *SQLiteStore) ListSessions(ctx context.Context, limit, offset int) ([]runtime.Session, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]runtime.Session, 0)
	for rows.Next() {
		var session runtime.Session
		var created, updated string
		if err := rows.Scan(&session.ID, &session.Title, &created, &updated); err != nil {
			return nil, err
		}
		if session.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		if session.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated); err != nil {
			return nil, err
		}
		result = append(result, session)
	}
	return result, rows.Err()
}

func (s *SQLiteStore) AppendEvent(ctx context.Context, event runtime.SessionEvent) (runtime.SessionEvent, error) {
	if strings.TrimSpace(event.SessionID) == "" {
		return runtime.SessionEvent{}, errors.New("session id is required")
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	if event.Payload == nil {
		event.Payload = json.RawMessage("null")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return runtime.SessionEvent{}, err
	}
	defer func() { _ = tx.Rollback() }()
	when := event.CreatedAt.UTC().Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, '', ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`, event.SessionID, when, when); err != nil {
		return runtime.SessionEvent{}, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE session_id = ?`, event.SessionID).Scan(&event.Sequence); err != nil {
		return runtime.SessionEvent{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO session_events(session_id, sequence, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`, event.SessionID, event.Sequence, event.RunID, event.Type, string(event.Payload), when); err != nil {
		return runtime.SessionEvent{}, err
	}
	if err := tx.Commit(); err != nil {
		return runtime.SessionEvent{}, err
	}
	return event, nil
}

func (s *SQLiteStore) Events(ctx context.Context, sessionID string, afterSequence int64) ([]runtime.SessionEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT sequence, run_id, type, payload, created_at FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence`, sessionID, afterSequence)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]runtime.SessionEvent, 0)
	for rows.Next() {
		var event runtime.SessionEvent
		var payload, created string
		if err := rows.Scan(&event.Sequence, &event.RunID, &event.Type, &payload, &created); err != nil {
			return nil, err
		}
		event.SessionID = sessionID
		event.Payload = json.RawMessage(payload)
		if event.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	return result, rows.Err()
}

func (s *SQLiteStore) AppendMessage(ctx context.Context, message runtime.Message) (runtime.Message, error) {
	if strings.TrimSpace(message.SessionID) == "" {
		return runtime.Message{}, errors.New("session id is required")
	}
	if strings.TrimSpace(message.Role) == "" {
		return runtime.Message{}, errors.New("message role is required")
	}
	if strings.TrimSpace(message.Content) == "" {
		return runtime.Message{}, errors.New("message content is required")
	}
	if message.ID == "" {
		message.ID = newID("msg")
	}
	if message.CreatedAt.IsZero() {
		message.CreatedAt = time.Now().UTC()
	}
	if err := s.CreateSession(ctx, message.SessionID); err != nil {
		return runtime.Message{}, err
	}
	// Client-provided message IDs make offline outbox retries idempotent. If a
	// retry arrives after the first write, return the original row instead of
	// turning a successful delivery into a duplicate-message error.
	_, err := s.db.ExecContext(ctx, `INSERT INTO messages(id, session_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET run_id = CASE WHEN messages.run_id = '' THEN excluded.run_id ELSE messages.run_id END`, message.ID, message.SessionID, message.RunID, message.Role, message.Content, message.CreatedAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return runtime.Message{}, err
	}
	stored, err := s.GetMessage(ctx, message.ID)
	if err != nil {
		return runtime.Message{}, err
	}
	if stored.SessionID != message.SessionID {
		return runtime.Message{}, fmt.Errorf("message %q already belongs to another session", message.ID)
	}
	if stored.ID == message.ID && stored.RunID == message.RunID && stored.Content == message.Content {
		_, err = s.db.ExecContext(ctx, `UPDATE sessions SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END WHERE id = ?`, message.CreatedAt.UTC().Format(time.RFC3339Nano), message.CreatedAt.UTC().Format(time.RFC3339Nano), message.SessionID)
	}
	return stored, err
}

func (s *SQLiteStore) Messages(ctx context.Context, sessionID string, after time.Time) ([]runtime.Message, error) {
	query := `SELECT id, session_id, run_id, role, content, created_at FROM messages WHERE session_id = ?`
	args := []any{sessionID}
	if !after.IsZero() {
		query += ` AND created_at > ?`
		args = append(args, after.UTC().Format(time.RFC3339Nano))
	}
	query += ` ORDER BY created_at, id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]runtime.Message, 0)
	for rows.Next() {
		var message runtime.Message
		var created string
		if err := rows.Scan(&message.ID, &message.SessionID, &message.RunID, &message.Role, &message.Content, &created); err != nil {
			return nil, err
		}
		if message.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		result = append(result, message)
	}
	return result, rows.Err()
}

// MessagesPage returns a bounded, stable timeline window. Cursors are message
// IDs rather than timestamps so messages written in the same clock tick are
// neither skipped nor repeated while a client scrolls upward or reconnects.
// The returned messages are always in ascending timeline order.
func (s *SQLiteStore) MessagesPage(ctx context.Context, sessionID, beforeID, afterID string, limit int) (runtime.MessagePage, error) {
	if strings.TrimSpace(sessionID) == "" {
		return runtime.MessagePage{}, errors.New("session id is required")
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if strings.TrimSpace(beforeID) != "" && strings.TrimSpace(afterID) != "" {
		return runtime.MessagePage{}, errors.New("before and after cursors are mutually exclusive")
	}

	args := []any{sessionID}
	query := `SELECT id, session_id, run_id, role, content, created_at FROM messages WHERE session_id = ?`
	order := ` ORDER BY created_at, id`
	descending := false
	if beforeID = strings.TrimSpace(beforeID); beforeID != "" {
		var cursorCreated string
		if err := s.db.QueryRowContext(ctx, `SELECT created_at FROM messages WHERE id = ? AND session_id = ?`, beforeID, sessionID).Scan(&cursorCreated); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return runtime.MessagePage{}, fmt.Errorf("message cursor %q not found", beforeID)
			}
			return runtime.MessagePage{}, err
		}
		query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
		args = append(args, cursorCreated, cursorCreated, beforeID)
		order = ` ORDER BY created_at DESC, id DESC`
		descending = true
	} else if afterID = strings.TrimSpace(afterID); afterID != "" {
		var cursorCreated string
		if err := s.db.QueryRowContext(ctx, `SELECT created_at FROM messages WHERE id = ? AND session_id = ?`, afterID, sessionID).Scan(&cursorCreated); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return runtime.MessagePage{}, fmt.Errorf("message cursor %q not found", afterID)
			}
			return runtime.MessagePage{}, err
		}
		query += ` AND (created_at > ? OR (created_at = ? AND id > ?))`
		args = append(args, cursorCreated, cursorCreated, afterID)
	}
	query += order + ` LIMIT ?`
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return runtime.MessagePage{}, err
	}
	defer rows.Close()
	result := make([]runtime.Message, 0, limit+1)
	for rows.Next() {
		var message runtime.Message
		var created string
		if err := rows.Scan(&message.ID, &message.SessionID, &message.RunID, &message.Role, &message.Content, &created); err != nil {
			return runtime.MessagePage{}, err
		}
		if message.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return runtime.MessagePage{}, err
		}
		result = append(result, message)
	}
	if err := rows.Err(); err != nil {
		return runtime.MessagePage{}, err
	}
	hasMore := len(result) > limit
	if hasMore {
		result = result[:limit]
	}
	if descending {
		for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
			result[left], result[right] = result[right], result[left]
		}
	}
	page := runtime.MessagePage{Messages: result, HasMore: hasMore}
	if len(result) > 0 {
		page.NextBefore = result[0].ID
		page.NextAfter = result[len(result)-1].ID
	}
	return page, nil
}

// SearchSessions provides a small, indexed-enough search surface for sidebar
// lookup. The query matches session IDs and titles, and also message content so
// a user can find a thread by something they remember writing.
func (s *SQLiteStore) SearchSessions(ctx context.Context, query string, limit, offset int) ([]runtime.Session, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return s.ListSessions(ctx, limit, offset)
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	pattern := "%" + query + "%"
	rows, err := s.db.QueryContext(ctx, `
		SELECT s.id, s.title, s.created_at, s.updated_at
		FROM sessions s
		WHERE s.id LIKE ? OR s.title LIKE ? OR EXISTS (
			SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ?
		)
		ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`, pattern, pattern, pattern, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]runtime.Session, 0)
	for rows.Next() {
		var session runtime.Session
		var created, updated string
		if err := rows.Scan(&session.ID, &session.Title, &created, &updated); err != nil {
			return nil, err
		}
		if session.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		if session.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated); err != nil {
			return nil, err
		}
		result = append(result, session)
	}
	return result, rows.Err()
}

func (s *SQLiteStore) GetMessage(ctx context.Context, messageID string) (runtime.Message, error) {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return runtime.Message{}, errors.New("message id is required")
	}
	var message runtime.Message
	var created string
	err := s.db.QueryRowContext(ctx, `SELECT id, session_id, run_id, role, content, created_at FROM messages WHERE id = ?`, messageID).Scan(&message.ID, &message.SessionID, &message.RunID, &message.Role, &message.Content, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return runtime.Message{}, fmt.Errorf("message %q not found", messageID)
	}
	if err != nil {
		return runtime.Message{}, err
	}
	message.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return message, err
}

func (s *SQLiteStore) CreateRun(ctx context.Context, run runtime.RunRecord) error {
	if run.ID == "" || run.SessionID == "" {
		return errors.New("run id and session id are required")
	}
	if err := s.CreateSession(ctx, run.SessionID); err != nil {
		return err
	}
	if run.CreatedAt.IsZero() {
		run.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO runs(id, session_id, provider, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`, run.ID, run.SessionID, run.Provider, run.Model, string(run.Status), run.CreatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *SQLiteStore) FinishRun(ctx context.Context, runID string, status runtime.RunStatus, finishedAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`, string(status), finishedAt.UTC().Format(time.RFC3339Nano), runID)
	return err
}

func (s *SQLiteStore) Run(ctx context.Context, runID string) (runtime.RunRecord, error) {
	var run runtime.RunRecord
	var status, created string
	var finished sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT id, session_id, provider, model, status, created_at, finished_at FROM runs WHERE id = ?`, runID).Scan(&run.ID, &run.SessionID, &run.Provider, &run.Model, &status, &created, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return runtime.RunRecord{}, fmt.Errorf("run %q not found", runID)
	}
	if err != nil {
		return runtime.RunRecord{}, err
	}
	run.Status = runtime.RunStatus(status)
	if run.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
		return runtime.RunRecord{}, err
	}
	if finished.Valid {
		value, parseErr := time.Parse(time.RFC3339Nano, finished.String)
		if parseErr != nil {
			return runtime.RunRecord{}, parseErr
		}
		run.FinishedAt = &value
	}
	return run, nil
}

func (s *SQLiteStore) ListRuns(ctx context.Context, sessionID string, limit int) ([]runtime.RunRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, session_id, provider, model, status, created_at, finished_at FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]runtime.RunRecord, 0)
	for rows.Next() {
		var run runtime.RunRecord
		var status, created string
		var finished sql.NullString
		if err := rows.Scan(&run.ID, &run.SessionID, &run.Provider, &run.Model, &status, &created, &finished); err != nil {
			return nil, err
		}
		run.Status = runtime.RunStatus(status)
		if run.CreatedAt, err = time.Parse(time.RFC3339Nano, created); err != nil {
			return nil, err
		}
		if finished.Valid {
			value, parseErr := time.Parse(time.RFC3339Nano, finished.String)
			if parseErr != nil {
				return nil, parseErr
			}
			run.FinishedAt = &value
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func newID(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}
