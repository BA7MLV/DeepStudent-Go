// Package attachments implements the local attachment boundary.
//
// Attachments are immutable, content-addressed blobs. Metadata lives in
// SQLite (storage.AttachmentStore), while this package owns the filesystem
// representation and workspace:// reference validation.
package attachments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	WorkspaceScheme = "workspace"
	workspaceHost   = "attachments"
	maxSniffBytes   = 512
)

var (
	ErrInvalidReference = errors.New("invalid workspace reference")
	ErrInvalidSHA256    = errors.New("invalid sha256 digest")
	ErrTooLarge         = errors.New("attachment exceeds the configured size limit")
	ErrMIMEType         = errors.New("attachment MIME type is not allowed")
	ErrNotFound         = errors.New("attachment blob not found")
	sha256Pattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// Policy constrains accepted attachment uploads. A zero MaxBytes means no
// limit. An empty AllowedMIMEs list allows any syntactically valid MIME type.
// Entries may be exact (application/pdf) or a type wildcard (image/*).
type Policy struct {
	MaxBytes     int64
	AllowedMIMEs []string
}

// DefaultPolicy is intentionally conservative for a local runtime while still
// accepting common text, document, image, audio and video attachments.
func DefaultPolicy() Policy {
	return Policy{
		MaxBytes: 32 << 20,
		AllowedMIMEs: []string{
			"text/*",
			"application/json",
			"application/pdf",
			"application/octet-stream",
			"image/*",
			"audio/*",
			"video/*",
		},
	}
}

// Digest returns the lower-case SHA-256 digest used by blob paths and
// workspace references.
func Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Metadata is the immutable record returned after a blob is accepted. The
// canonical reference is suitable for inclusion in runtime event payloads.
type Metadata struct {
	SHA256       string    `json:"sha256"`
	Size         int64     `json:"size"`
	MIME         string    `json:"mime"`
	Filename     string    `json:"filename,omitempty"`
	WorkspaceRef string    `json:"workspace_ref"`
	CreatedAt    time.Time `json:"created_at"`
}

// Upload contains caller-provided metadata for a blob upload.
type Upload struct {
	Reader      io.Reader
	MIME        string
	Filename    string
}

// BlobStore stores immutable SHA-256-addressed files below root. It never
// accepts a path supplied by a caller; callers resolve through workspace://.
type BlobStore struct {
	root   string
	policy Policy
	now    func() time.Time
}

func NewBlobStore(root string, policy Policy) (*BlobStore, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("blob root is required")
	}
	if policy.MaxBytes < 0 {
		return nil, errors.New("attachment max bytes must not be negative")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create blob root: %w", err)
	}
	return &BlobStore{root: root, policy: policy, now: time.Now}, nil
}

func (s *BlobStore) Root() string { return s.root }
func (s *BlobStore) Policy() Policy {
	return Policy{MaxBytes: s.policy.MaxBytes, AllowedMIMEs: append([]string(nil), s.policy.AllowedMIMEs...)}
}

// Put streams an upload to a temporary file, computes SHA-256, validates its
// size/MIME, and atomically places it in the content-addressed blob tree.
func (s *BlobStore) Put(ctx context.Context, upload Upload) (Metadata, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if upload.Reader == nil {
		return Metadata{}, errors.New("attachment reader is required")
	}
	mimeType, err := normalizeMIME(upload.MIME)
	if err != nil {
		return Metadata{}, err
	}
	if mimeType != "" {
		if err := s.policy.ValidateMIME(mimeType); err != nil {
			return Metadata{}, err
		}
	}

	tmp, err := os.CreateTemp(s.root, ".upload-*")
	if err != nil {
		return Metadata{}, fmt.Errorf("create attachment temp file: %w", err)
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpName)
		}
	}()

	hash := sha256.New()
	writer := io.MultiWriter(tmp, hash)
	var reader io.Reader = upload.Reader
	if s.policy.MaxBytes > 0 {
		reader = io.LimitReader(upload.Reader, s.policy.MaxBytes+1)
	}
	n, err := copyContext(ctx, writer, reader)
	if err != nil {
		return Metadata{}, err
	}
	if err := s.policy.ValidateSize(n); err != nil {
		return Metadata{}, err
	}
	if err := ctx.Err(); err != nil {
		return Metadata{}, err
	}
	if err := tmp.Sync(); err != nil {
		return Metadata{}, fmt.Errorf("sync attachment blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return Metadata{}, fmt.Errorf("close attachment blob: %w", err)
	}

	detectedMIME, err := sniffMIME(tmpName)
	if err != nil {
		return Metadata{}, err
	}
	if mimeType == "" {
		mimeType = detectedMIME
	} else if !mimeCompatible(mimeType, detectedMIME) {
		return Metadata{}, fmt.Errorf("%w: declared %s does not match detected %s", ErrMIMEType, mimeType, detectedMIME)
	}
	if err := s.policy.ValidateMIME(mimeType); err != nil {
		return Metadata{}, err
	}

	digest := hex.EncodeToString(hash.Sum(nil))
	ref, err := WorkspaceRef(digest)
	if err != nil {
		return Metadata{}, err
	}
	path, err := s.PathForSHA256(digest)
	if err != nil {
		return Metadata{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return Metadata{}, fmt.Errorf("create blob shard: %w", err)
	}
	if _, err := os.Stat(path); err == nil {
		// The content is already present. Discard the temporary copy; metadata
		// insertion remains idempotent in SQLite.
		if err := os.Remove(tmpName); err != nil {
			return Metadata{}, fmt.Errorf("discard duplicate attachment blob: %w", err)
		}
		committed = true
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(tmpName, path); err != nil {
			if !errors.Is(err, os.ErrExist) {
				return Metadata{}, fmt.Errorf("commit attachment blob: %w", err)
			}
		} else {
			committed = true
		}
	} else {
		return Metadata{}, fmt.Errorf("inspect attachment blob: %w", err)
	}
	return Metadata{
		SHA256:       digest,
		Size:         n,
		MIME:         mimeType,
		Filename:     cleanFilename(upload.Filename),
		WorkspaceRef: ref,
		CreatedAt:    s.now().UTC(),
	}, nil
}

// Open resolves a canonical workspace:// reference and opens its immutable
// blob. The digest is validated before any filesystem operation.
func (s *BlobStore) Open(ref string) (io.ReadCloser, error) {
	digest, err := ParseWorkspaceRef(ref)
	if err != nil {
		return nil, err
	}
	path, err := s.PathForSHA256(digest)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open attachment blob: %w", err)
	}
	return file, nil
}

// PathForSHA256 returns the deterministic on-disk location for a digest.
func (s *BlobStore) PathForSHA256(digest string) (string, error) {
	digest = strings.ToLower(strings.TrimSpace(digest))
	if !sha256Pattern.MatchString(digest) {
		return "", ErrInvalidSHA256
	}
	return filepath.Join(s.root, digest[:2], digest), nil
}

// WorkspaceRef returns the only canonical reference form emitted by this
// package. ParseWorkspaceRef also accepts workspace://<digest> for compatibility
// with early clients that omitted the attachments host.
func WorkspaceRef(digest string) (string, error) {
	digest = strings.ToLower(strings.TrimSpace(digest))
	if !sha256Pattern.MatchString(digest) {
		return "", ErrInvalidSHA256
	}
	return WorkspaceScheme + "://" + workspaceHost + "/" + digest, nil
}

// ParseWorkspaceRef validates a workspace reference and returns its digest.
func ParseWorkspaceRef(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" || strings.ContainsAny(ref, "\r\n") {
		return "", ErrInvalidReference
	}
	// Avoid url.PathUnescape accepting encoded separators or dot segments by
	// validating the raw shape before parsing.
	if !strings.HasPrefix(ref, WorkspaceScheme+"://") {
		return "", ErrInvalidReference
	}
	body := strings.TrimPrefix(ref, WorkspaceScheme+"://")
	parts := strings.Split(body, "/")
	var digest string
	switch len(parts) {
	case 1:
		// Compatibility form: workspace://<sha256>
		digest = parts[0]
	case 2:
		if parts[0] != workspaceHost {
			return "", ErrInvalidReference
		}
		digest = parts[1]
	default:
		return "", ErrInvalidReference
	}
	digest = strings.ToLower(digest)
	if !sha256Pattern.MatchString(digest) {
		return "", ErrInvalidReference
	}
	return digest, nil
}

// ValidateSize applies the configured byte limit without reading the blob.
func (p Policy) ValidateSize(size int64) error {
	if size < 0 {
		return errors.New("attachment size must not be negative")
	}
	if p.MaxBytes > 0 && size > p.MaxBytes {
		return ErrTooLarge
	}
	return nil
}

func (p Policy) ValidateMIME(value string) error {
	value, err := normalizeMIME(value)
	if err != nil {
		return err
	}
	if value == "" {
		return ErrMIMEType
	}
	if len(p.AllowedMIMEs) == 0 {
		return nil
	}
	for _, allowed := range p.AllowedMIMEs {
		allowed, err = normalizeMIMEPattern(allowed)
		if err != nil {
			continue
		}
		if allowed == value || (strings.HasSuffix(allowed, "/*") && strings.HasPrefix(value, strings.TrimSuffix(allowed, "*"))) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrMIMEType, value)
}

func mimeCompatible(declared, detected string) bool {
	declared, declaredErr := normalizeMIME(declared)
	detected, detectedErr := normalizeMIME(detected)
	if declaredErr != nil || detectedErr != nil || declared == "" || detected == "" {
		return false
	}
	// Generic sniffing cannot identify an arbitrary binary payload. A caller
	// may still provide a more precise type in that case.
	if detected == "application/octet-stream" || declared == "application/octet-stream" {
		return true
	}
	if declared == detected {
		return true
	}
	// JSON is commonly detected as text/plain by net/http's conservative
	// sniffer; accept that specific safe refinement while rejecting a broad
	// type-family mismatch such as text/plain declared as image/png.
	if declared == "application/json" && detected == "text/plain" {
		return true
	}
	declaredMajor := strings.SplitN(declared, "/", 2)[0]
	detectedMajor := strings.SplitN(detected, "/", 2)[0]
	return declaredMajor == detectedMajor
}

func normalizeMIME(value string) (string, error) {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return "", nil
	}
	parsed, _, err := mime.ParseMediaType(value)
	if err != nil || parsed == "" || strings.ContainsAny(parsed, "\r\n") {
		return "", fmt.Errorf("%w: invalid MIME type", ErrMIMEType)
	}
	return parsed, nil
}

func normalizeMIMEPattern(value string) (string, error) {
	value = strings.TrimSpace(strings.ToLower(value))
	if strings.HasSuffix(value, "/*") {
		if strings.Count(value, "/") != 1 || strings.TrimSuffix(value, "/*") == "" {
			return "", ErrMIMEType
		}
		return value, nil
	}
	return normalizeMIME(value)
}

func sniffMIME(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("read attachment MIME: %w", err)
	}
	defer file.Close()
	buf := make([]byte, maxSniffBytes)
	n, err := file.Read(buf)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read attachment MIME: %w", err)
	}
	return http.DetectContentType(buf[:n]), nil
}

func copyContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	buf := make([]byte, 32*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			written, writeErr := dst.Write(buf[:n])
			total += int64(written)
			if writeErr != nil {
				return total, writeErr
			}
			if written != n {
				return total, io.ErrShortWrite
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return total, nil
			}
			return total, readErr
		}
	}
}

func cleanFilename(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = filepath.Base(filepath.Clean(value))
	if value == "." || value == string(filepath.Separator) || strings.ContainsAny(value, "\x00\r\n") {
		return ""
	}
	return value
}
