package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
)

// AttachmentStore composes the SQLite metadata store with a content-addressed
// filesystem blob store. Metadata is keyed by SHA-256, so repeated uploads of
// the same bytes are deduplicated without losing a stable workspace reference.
type AttachmentStore struct {
	db    *SQLiteStore
	blobs *attachments.BlobStore
}

func NewAttachmentStore(db *SQLiteStore, blobRoot string, policy attachments.Policy) (*AttachmentStore, error) {
	if db == nil || db.DB() == nil {
		return nil, errors.New("sqlite store is required")
	}
	blobs, err := attachments.NewBlobStore(blobRoot, policy)
	if err != nil {
		return nil, err
	}
	return &AttachmentStore{db: db, blobs: blobs}, nil
}

func (s *AttachmentStore) BlobStore() *attachments.BlobStore { return s.blobs }

// Put validates and persists an attachment. The blob is committed before its
// metadata row; an interrupted process can therefore leave an unreferenced
// immutable blob, which is safe to reclaim with a future garbage collector.
func (s *AttachmentStore) Put(ctx context.Context, upload attachments.Upload) (attachments.Metadata, error) {
	metadata, err := s.blobs.Put(ctx, upload)
	if err != nil {
		return attachments.Metadata{}, err
	}
	return s.db.insertAttachment(ctx, metadata)
}

// Save is an alias for Put for callers that model attachment writes as a
// metadata save operation.
func (s *AttachmentStore) Save(ctx context.Context, upload attachments.Upload) (attachments.Metadata, error) {
	return s.Put(ctx, upload)
}

// Metadata resolves a workspace:// reference to its SQLite record.
func (s *AttachmentStore) Metadata(ctx context.Context, ref string) (attachments.Metadata, error) {
	digest, err := attachments.ParseWorkspaceRef(ref)
	if err != nil {
		return attachments.Metadata{}, err
	}
	return s.db.attachment(ctx, digest)
}

// Get is an alias for Metadata.
func (s *AttachmentStore) Get(ctx context.Context, ref string) (attachments.Metadata, error) {
	return s.Metadata(ctx, ref)
}

// Open resolves a tracked workspace:// reference and opens its blob. Looking up
// metadata first prevents callers from reading orphaned files in the blob root.
func (s *AttachmentStore) Open(ctx context.Context, ref string) (io.ReadCloser, attachments.Metadata, error) {
	metadata, err := s.Metadata(ctx, ref)
	if err != nil {
		return nil, attachments.Metadata{}, err
	}
	file, err := s.blobs.Open(metadata.WorkspaceRef)
	if err != nil {
		return nil, attachments.Metadata{}, err
	}
	return file, metadata, nil
}

func (s *AttachmentStore) List(ctx context.Context, limit int) ([]attachments.Metadata, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.DB().QueryContext(ctx, `SELECT sha256, size, mime, filename, workspace_ref, created_at FROM attachments ORDER BY created_at, sha256 LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]attachments.Metadata, 0)
	for rows.Next() {
		metadata, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, metadata)
	}
	return result, rows.Err()
}

func (s *SQLiteStore) insertAttachment(ctx context.Context, metadata attachments.Metadata) (attachments.Metadata, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if metadata.SHA256 == "" || metadata.WorkspaceRef == "" || metadata.MIME == "" || metadata.Size < 0 || metadata.CreatedAt.IsZero() {
		return attachments.Metadata{}, errors.New("attachment metadata is incomplete")
	}
	if _, err := attachments.ParseWorkspaceRef(metadata.WorkspaceRef); err != nil {
		return attachments.Metadata{}, err
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO attachments(sha256, size, mime, filename, workspace_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`, metadata.SHA256, metadata.Size, metadata.MIME, metadata.Filename, metadata.WorkspaceRef, metadata.CreatedAt.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return attachments.Metadata{}, fmt.Errorf("insert attachment metadata: %w", err)
	}
	return s.attachment(ctx, metadata.SHA256)
}

func (s *SQLiteStore) attachment(ctx context.Context, digest string) (attachments.Metadata, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	var metadata attachments.Metadata
	var created string
	err := s.db.QueryRowContext(ctx, `SELECT sha256, size, mime, filename, workspace_ref, created_at FROM attachments WHERE sha256 = ?`, digest).Scan(&metadata.SHA256, &metadata.Size, &metadata.MIME, &metadata.Filename, &metadata.WorkspaceRef, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return attachments.Metadata{}, attachments.ErrNotFound
	}
	if err != nil {
		return attachments.Metadata{}, err
	}
	metadata.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return attachments.Metadata{}, fmt.Errorf("parse attachment created_at: %w", err)
	}
	return metadata, nil
}

func scanAttachment(rows *sql.Rows) (attachments.Metadata, error) {
	var metadata attachments.Metadata
	var created string
	if err := rows.Scan(&metadata.SHA256, &metadata.Size, &metadata.MIME, &metadata.Filename, &metadata.WorkspaceRef, &created); err != nil {
		return attachments.Metadata{}, err
	}
	var err error
	metadata.CreatedAt, err = time.Parse(time.RFC3339Nano, strings.TrimSpace(created))
	if err != nil {
		return attachments.Metadata{}, fmt.Errorf("parse attachment created_at: %w", err)
	}
	return metadata, nil
}
