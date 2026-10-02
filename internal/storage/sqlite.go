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
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/runtime"
	_ "modernc.org/sqlite"
)

const schemaVersion = 1

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
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
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
	statements := []string{
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, FOREIGN KEY(session_id) REFERENCES sessions(id))`,
		`CREATE TABLE IF NOT EXISTS session_events (session_id TEXT NOT NULL, sequence INTEGER NOT NULL, run_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, sequence), FOREIGN KEY(session_id) REFERENCES sessions(id))`,
		`CREATE TABLE IF NOT EXISTS provider_profiles (name TEXT PRIMARY KEY, base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', api_key_env TEXT NOT NULL DEFAULT '', timeout_ms INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration: %w", err)
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration statement: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)`, schemaVersion, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("record migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) CreateSession(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return errors.New("session id is required")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO sessions(id, created_at, updated_at) VALUES (?, ?, ?)`, sessionID, now, now)
	return err
}

func (s *SQLiteStore) AppendEvent(ctx context.Context, event runtime.SessionEvent) (runtime.SessionEvent, error) {
	if event.SessionID == "" {
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
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO sessions(id, created_at, updated_at) VALUES (?, ?, ?)`, event.SessionID, event.CreatedAt.Format(time.RFC3339Nano), event.CreatedAt.Format(time.RFC3339Nano)); err != nil {
		return runtime.SessionEvent{}, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE session_id = ?`, event.SessionID).Scan(&event.Sequence); err != nil {
		return runtime.SessionEvent{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO session_events(session_id, sequence, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`, event.SessionID, event.Sequence, event.RunID, event.Type, string(event.Payload), event.CreatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return runtime.SessionEvent{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET updated_at = ? WHERE id = ?`, event.CreatedAt.Format(time.RFC3339Nano), event.SessionID); err != nil {
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
	var result []runtime.SessionEvent
	for rows.Next() {
		var event runtime.SessionEvent
		var payload, created string
		if err := rows.Scan(&event.Sequence, &event.RunID, &event.Type, &payload, &created); err != nil {
			return nil, err
		}
		event.SessionID = sessionID
		event.Payload = json.RawMessage(payload)
		event.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
		if err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	return result, rows.Err()
}
