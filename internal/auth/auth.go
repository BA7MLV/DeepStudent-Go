// Package auth defines the security boundary without enabling login by default.
package auth

import (
	"context"
	"errors"
	"net/http"
	"time"
)

type Principal struct {
	Subject string
}

type Session struct {
	ID        string
	Subject   string
	ExpiresAt time.Time
}

// Authenticator is implemented by a future server-side session backend. The
// API never accepts provider keys or session credentials from JSON payloads.
type Authenticator interface {
	Authenticate(ctx context.Context, r *http.Request) (Principal, bool, error)
	CreateSession(ctx context.Context, subject string, ttl time.Duration) (Session, error)
	RevokeSession(ctx context.Context, sessionID string) error
}

// PasswordHasher is deliberately an interface. Any login implementation must
// use Argon2id behind this boundary and keep hashes server-side.
type PasswordHasher interface {
	Hash(password []byte) ([]byte, error)
	Compare(hash, password []byte) error
}

var ErrUnavailable = errors.New("authentication is not configured")
