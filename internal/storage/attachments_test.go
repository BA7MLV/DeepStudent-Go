package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
)

func TestAttachmentStorePersistsMetadataAndBlob(t *testing.T) {
	dir := t.TempDir()
	db, err := OpenSQLite(context.Background(), filepath.Join(dir, "deepstudent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store, err := NewAttachmentStore(db, filepath.Join(dir, "blobs"), attachments.Policy{MaxBytes: 1024, AllowedMIMEs: []string{"text/plain"}})
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := store.Put(context.Background(), attachments.Upload{Reader: bytes.NewBufferString("notes"), MIME: "text/plain", Filename: "notes.txt"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Metadata(context.Background(), metadata.WorkspaceRef)
	if err != nil {
		t.Fatal(err)
	}
	if got.SHA256 != metadata.SHA256 || got.Size != 5 || got.Filename != "notes.txt" {
		t.Fatalf("metadata mismatch: %+v vs %+v", got, metadata)
	}
	file, got, err := store.Open(context.Background(), metadata.WorkspaceRef)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "notes" || got.WorkspaceRef != metadata.WorkspaceRef {
		t.Fatalf("open result = %q, %+v", body, got)
	}
	rows, err := store.List(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("metadata rows = %d", len(rows))
	}
	if _, _, err := store.Open(context.Background(), "workspace://attachments/"+strings.Repeat("0", 64)); !errors.Is(err, attachments.ErrNotFound) {
		t.Fatalf("missing metadata error = %v", err)
	}
}
