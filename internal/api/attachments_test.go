package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BA7MLV/DeepStudent-Go/internal/attachments"
	"github.com/BA7MLV/DeepStudent-Go/internal/config"
	"github.com/BA7MLV/DeepStudent-Go/internal/storage"
)

func TestAttachmentHTTPUploadMetadataAndContent(t *testing.T) {
	server, cleanup := newAttachmentTestServer(t)
	defer cleanup()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="../lesson.txt"`)
	header.Set("Content-Type", "text/plain; charset=utf-8")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("hello attachment")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res := httptest.NewRecorder()
	server.ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", res.Code, res.Body.String())
	}
	var uploaded struct {
		Attachment attachments.Metadata `json:"attachment"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Attachment.SHA256 == "" || uploaded.Attachment.WorkspaceRef == "" {
		t.Fatalf("upload metadata = %+v", uploaded.Attachment)
	}
	if uploaded.Attachment.Filename != "lesson.txt" {
		t.Fatalf("filename = %q", uploaded.Attachment.Filename)
	}

	metadataReq := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/"+uploaded.Attachment.SHA256+"?metadata=1", nil)
	metadataRes := httptest.NewRecorder()
	server.ServeHTTP(metadataRes, metadataReq)
	if metadataRes.Code != http.StatusOK {
		t.Fatalf("metadata status = %d, body = %s", metadataRes.Code, metadataRes.Body.String())
	}
	var metadataBody struct {
		Attachment attachments.Metadata `json:"attachment"`
	}
	if err := json.Unmarshal(metadataRes.Body.Bytes(), &metadataBody); err != nil {
		t.Fatal(err)
	}
	if metadataBody.Attachment != uploaded.Attachment {
		t.Fatalf("metadata = %+v, uploaded = %+v", metadataBody.Attachment, uploaded.Attachment)
	}

	contentReq := httptest.NewRequest(http.MethodGet, "/api/v1/attachments/"+uploaded.Attachment.SHA256, nil)
	contentRes := httptest.NewRecorder()
	server.ServeHTTP(contentRes, contentReq)
	if contentRes.Code != http.StatusOK || contentRes.Body.String() != "hello attachment" {
		t.Fatalf("content status = %d, body = %q", contentRes.Code, contentRes.Body.String())
	}
	if got := contentRes.Header().Get("ETag"); got != `"`+uploaded.Attachment.SHA256+`"` {
		t.Fatalf("etag = %q", got)
	}

	refReq := httptest.NewRequest(http.MethodGet, "/api/v1/attachments?ref="+uploaded.Attachment.WorkspaceRef, nil)
	refRes := httptest.NewRecorder()
	server.ServeHTTP(refRes, refReq)
	if refRes.Code != http.StatusOK {
		t.Fatalf("workspace metadata status = %d, body = %s", refRes.Code, refRes.Body.String())
	}
}

func TestAttachmentHTTPRejectsUnsafeReferences(t *testing.T) {
	server, cleanup := newAttachmentTestServer(t)
	defer cleanup()

	for _, target := range []string{
		"/api/v1/attachments/../secrets",
		"/api/v1/attachments/workspace://attachments/not-a-sha",
		"/api/v1/attachments?ref=workspace://attachments/../../etc/passwd",
	} {
		res := httptest.NewRecorder()
		server.ServeHTTP(res, httptest.NewRequest(http.MethodGet, target, nil))
		if res.Code != http.StatusBadRequest {
			t.Errorf("target %q status = %d, body = %s", target, res.Code, res.Body.String())
		}
	}
}

func TestAttachmentHTTPMapsMissingBlobToNotFound(t *testing.T) {
	server, cleanup := newAttachmentTestServer(t)
	defer cleanup()
	digest := strings.Repeat("a", 64)
	res := httptest.NewRecorder()
	server.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/attachments/"+digest, nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d, body = %s", res.Code, res.Body.String())
	}
}

func newAttachmentTestServer(t *testing.T) (*Server, func()) {
	t.Helper()
	dir := t.TempDir()
	db, err := storage.OpenSQLite(context.Background(), filepath.Join(dir, "deepstudent.db"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.NewAttachmentStore(db, filepath.Join(dir, "blobs"), attachments.Policy{MaxBytes: 1024, AllowedMIMEs: []string{"text/*", "application/octet-stream"}})
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.Storage.AttachmentMaxBytes = 1024
	return NewServer(cfg, nil, store), func() { _ = db.Close() }
}
