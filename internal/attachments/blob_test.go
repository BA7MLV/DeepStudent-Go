package attachments

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestBlobStoreRoundTripAndWorkspaceRef(t *testing.T) {
	store, err := NewBlobStore(filepath.Join(t.TempDir(), "blobs"), Policy{MaxBytes: 1024, AllowedMIMEs: []string{"text/plain"}})
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := store.Put(context.Background(), Upload{Reader: bytes.NewBufferString("hello"), MIME: "text/plain; charset=utf-8", Filename: "../notes.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if metadata.SHA256 != Digest([]byte("hello")) {
		t.Fatalf("sha256 = %q", metadata.SHA256)
	}
	if metadata.WorkspaceRef != "workspace://attachments/"+metadata.SHA256 {
		t.Fatalf("workspace ref = %q", metadata.WorkspaceRef)
	}
	if metadata.Filename != "notes.txt" {
		t.Fatalf("filename = %q", metadata.Filename)
	}
	if got, err := ParseWorkspaceRef(metadata.WorkspaceRef); err != nil || got != metadata.SHA256 {
		t.Fatalf("parse workspace ref: %q, %v", got, err)
	}
	file, err := store.Open(metadata.WorkspaceRef)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "hello" {
		t.Fatalf("body = %q", body)
	}
}

func TestBlobStoreRejectsSizeAndMIME(t *testing.T) {
	store, err := NewBlobStore(t.TempDir(), Policy{MaxBytes: 4, AllowedMIMEs: []string{"text/plain"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), Upload{Reader: bytes.NewBufferString("12345"), MIME: "text/plain"}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversize error = %v", err)
	}
	if _, err := store.Put(context.Background(), Upload{Reader: bytes.NewBufferString("ok"), MIME: "image/png"}); !errors.Is(err, ErrMIMEType) {
		t.Fatalf("MIME policy error = %v", err)
	}
	permissive, err := NewBlobStore(t.TempDir(), Policy{MaxBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := permissive.Put(context.Background(), Upload{Reader: bytes.NewBufferString("plain text"), MIME: "image/png"}); !errors.Is(err, ErrMIMEType) {
		t.Fatalf("MIME mismatch error = %v", err)
	}
}

func TestBlobStoreDeduplicatesContent(t *testing.T) {
	root := t.TempDir()
	store, err := NewBlobStore(root, Policy{MaxBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Put(context.Background(), Upload{Reader: bytes.NewBufferString("same"), MIME: "text/plain"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(context.Background(), Upload{Reader: bytes.NewBufferString("same"), MIME: "text/plain"})
	if err != nil {
		t.Fatal(err)
	}
	if first.SHA256 != second.SHA256 || first.WorkspaceRef != second.WorkspaceRef {
		t.Fatalf("dedupe mismatch: %+v %+v", first, second)
	}
	path, err := store.PathForSHA256(first.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
