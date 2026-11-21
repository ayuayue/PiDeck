package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
)

type pendingMobileFileRequest struct {
	method  string
	project string
	path    string
	write   remotewire.FileWrite
	reply   chan mobileFileReply
}

type mobileFileReply struct {
	status int
	body   any
}

func newMobileFilesTestApp(t *testing.T) (*mobileApp, <-chan func()) {
	return newConnectionTestApp(t)
}

func newMobileFilesTestServer(t *testing.T) (*remoteClient, <-chan pendingMobileFileRequest) {
	t.Helper()
	requests := make(chan pendingMobileFileRequest, 8)
	stop := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := pendingMobileFileRequest{method: r.Method, reply: make(chan mobileFileReply, 1)}
		switch {
		case r.URL.Path == "/api/files" && r.Method == http.MethodGet:
			request.project = r.URL.Query().Get("project")
		case r.URL.Path == "/api/file" && r.Method == http.MethodGet:
			request.project = r.URL.Query().Get("project")
			request.path = r.URL.Query().Get("path")
		case r.URL.Path == "/api/file" && r.Method == http.MethodPost:
			if err := json.NewDecoder(r.Body).Decode(&request.write); err != nil {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			request.project, request.path = request.write.Project, request.write.Path
		default:
			http.NotFound(w, r)
			return
		}
		select {
		case requests <- request:
		case <-stop:
			return
		}
		select {
		case reply := <-request.reply:
			w.WriteHeader(reply.status)
			if reply.body != nil {
				_ = json.NewEncoder(w).Encode(reply.body)
			}
		case <-r.Context().Done():
		case <-stop:
		}
	}))
	t.Cleanup(func() { close(stop); server.Close() })
	return &remoteClient{base: server.URL, source: server.URL, token: "fixture", http: server.Client()}, requests
}

func nextMobileFileRequest(t *testing.T, requests <-chan pendingMobileFileRequest) pendingMobileFileRequest {
	t.Helper()
	select {
	case request := <-requests:
		return request
	case <-time.After(5 * time.Second):
		t.Fatal("file request did not reach the server")
		return pendingMobileFileRequest{}
	}
}

func replyMobileFileRequest(t *testing.T, posts <-chan func(), request pendingMobileFileRequest, status int, body any) {
	t.Helper()
	request.reply <- mobileFileReply{status: status, body: body}
	runConnectionPost(t, posts)
}

func TestMobileFilesIgnorePreviousProjectRead(t *testing.T) {
	a, posts := newMobileFilesTestApp(t)
	client, requests := newMobileFilesTestServer(t)
	a.client = client
	a.openFiles("/project/old", "old")
	old := nextMobileFileRequest(t, requests)
	a.openFiles("/project/current", "current")
	current := nextMobileFileRequest(t, requests)
	if old.project != "/project/old" || current.project != "/project/current" {
		t.Fatalf("file requests were sent for projects %q and %q", old.project, current.project)
	}

	replyMobileFileRequest(t, posts, old, http.StatusForbidden, map[string]string{"error": "old denied"})
	if !a.filesBusy.GetUntracked() || len(a.filesList.GetUntracked()) != 0 || a.filesErr.GetUntracked() != "" {
		t.Fatalf("old project response changed current list: busy=%v files=%+v error=%q", a.filesBusy.GetUntracked(), a.filesList.GetUntracked(), a.filesErr.GetUntracked())
	}

	replyMobileFileRequest(t, posts, current, http.StatusOK, map[string]any{"files": []remotewire.File{{Path: "current.txt"}}})
	files := a.filesList.GetUntracked()
	if a.filesBusy.GetUntracked() || a.filesErr.GetUntracked() != "" || len(files) != 1 || files[0].Path != "current.txt" {
		t.Fatalf("current list did not load: busy=%v files=%+v error=%q", a.filesBusy.GetUntracked(), files, a.filesErr.GetUntracked())
	}
}

func TestMobileFilesCloseAndReopenIgnoresPreviousRead(t *testing.T) {
	a, posts := newMobileFilesTestApp(t)
	client, requests := newMobileFilesTestServer(t)
	a.client = client
	a.openFiles("/project", "project")
	old := nextMobileFileRequest(t, requests)
	a.closeFilesView()
	a.openFiles("/project", "project")
	current := nextMobileFileRequest(t, requests)

	replyMobileFileRequest(t, posts, old, http.StatusOK, map[string]any{"files": []remotewire.File{{Path: "stale.txt"}}})
	if !a.filesBusy.GetUntracked() || len(a.filesList.GetUntracked()) != 0 {
		t.Fatalf("closed view response changed the reopened list: busy=%v files=%+v", a.filesBusy.GetUntracked(), a.filesList.GetUntracked())
	}
	replyMobileFileRequest(t, posts, current, http.StatusOK, map[string]any{"files": []remotewire.File{{Path: "current.txt"}}})
	files := a.filesList.GetUntracked()
	if a.filesBusy.GetUntracked() || len(files) != 1 || files[0].Path != "current.txt" {
		t.Fatalf("reopened file list did not load: busy=%v files=%+v", a.filesBusy.GetUntracked(), files)
	}
}

func TestMobileFileCloseAndReopenIgnoresPreviousRead(t *testing.T) {
	a, posts := newMobileFilesTestApp(t)
	client, requests := newMobileFilesTestServer(t)
	a.client = client
	a.filesProject.Set("/project")
	a.openFile("note.txt")
	old := nextMobileFileRequest(t, requests)
	a.closeFileView()
	a.openFile("note.txt")
	current := nextMobileFileRequest(t, requests)

	replyMobileFileRequest(t, posts, old, http.StatusOK, remotewire.FileText{Text: "stale"})
	if !a.fileBusy.GetUntracked() || !a.fileOpen.GetUntracked() || a.fileText.GetUntracked() != "" {
		t.Fatalf("closed file response changed reopened view: busy=%v open=%v text=%q", a.fileBusy.GetUntracked(), a.fileOpen.GetUntracked(), a.fileText.GetUntracked())
	}
	replyMobileFileRequest(t, posts, current, http.StatusOK, remotewire.FileText{Text: "current", Revision: "r2", Writable: true})
	if a.fileBusy.GetUntracked() || a.fileText.GetUntracked() != "current" || a.fileEdit.revision.GetUntracked() != "r2" {
		t.Fatalf("reopened file did not load: busy=%v text=%q revision=%q", a.fileBusy.GetUntracked(), a.fileText.GetUntracked(), a.fileEdit.revision.GetUntracked())
	}
}

func TestMobileFilesReconnectReleasesPreviousRead(t *testing.T) {
	a, posts := newMobileFilesTestApp(t)
	previous, requests := newMobileFilesTestServer(t)
	a.client = previous
	a.connected.Set(true)
	a.openFiles("/project/previous", "previous")
	old := nextMobileFileRequest(t, requests)
	a.disconnectWith("left server")
	if a.filesBusy.GetUntracked() || a.filesOpen.GetUntracked() {
		t.Fatal("disconnect left the previous file list open or loading")
	}

	current, currentRequests := newMobileFilesTestServer(t)
	a.client = current
	a.connected.Set(true)
	a.openFiles("/project/current", "current")
	newRead := nextMobileFileRequest(t, currentRequests)

	replyMobileFileRequest(t, posts, old, http.StatusUnauthorized, nil)
	if a.client != current || !a.connected.GetUntracked() || !a.filesBusy.GetUntracked() || a.filesErr.GetUntracked() != "" {
		t.Fatalf("previous connection changed the current file view: connected=%v busy=%v error=%q", a.connected.GetUntracked(), a.filesBusy.GetUntracked(), a.filesErr.GetUntracked())
	}

	replyMobileFileRequest(t, posts, newRead, http.StatusOK, map[string]any{"files": []remotewire.File{{Path: "new.txt"}}})
	files := a.filesList.GetUntracked()
	if a.filesBusy.GetUntracked() || len(files) != 1 || files[0].Path != "new.txt" {
		t.Fatalf("reconnected file list did not load: busy=%v files=%+v", a.filesBusy.GetUntracked(), files)
	}
}

func TestMobileFileReadIgnoresPreviousConnection(t *testing.T) {
	a, posts := newMobileFilesTestApp(t)
	previous, oldRequests := newMobileFilesTestServer(t)
	a.client = previous
	a.filesProject.Set("/project/previous")
	a.openFile("previous.txt")
	old := nextMobileFileRequest(t, oldRequests)
	a.disconnect()

	current, currentRequests := newMobileFilesTestServer(t)
	a.client = current
	a.filesProject.Set("/project/current")
	a.openFile("current.txt")
	read := nextMobileFileRequest(t, currentRequests)
	replyMobileFileRequest(t, posts, old, http.StatusUnauthorized, nil)
	if a.client != current || !a.fileBusy.GetUntracked() || a.fileTitle.GetUntracked() != "current.txt" || a.fileErr.GetUntracked() != "" {
		t.Fatalf("previous file read changed current view: busy=%v title=%q error=%q", a.fileBusy.GetUntracked(), a.fileTitle.GetUntracked(), a.fileErr.GetUntracked())
	}

	replyMobileFileRequest(t, posts, read, http.StatusOK, remotewire.FileText{
		Path: "current.txt", Text: "current contents", Revision: "r2", Writable: true,
	})
	if a.fileBusy.GetUntracked() || a.fileText.GetUntracked() != "current contents" || a.fileEdit.revision.GetUntracked() != "r2" {
		t.Fatalf("current file did not load: busy=%v text=%q revision=%q", a.fileBusy.GetUntracked(), a.fileText.GetUntracked(), a.fileEdit.revision.GetUntracked())
	}
}

func TestMobileDisconnectPreservesUnsavedFileEdit(t *testing.T) {
	a, posts := newMobileFilesTestApp(t)
	client, requests := newMobileFilesTestServer(t)
	a.client = client
	a.connected.Set(true)
	a.filesProject.Set("/project")
	a.openFile("note.txt")
	read := nextMobileFileRequest(t, requests)
	replyMobileFileRequest(t, posts, read, http.StatusOK, remotewire.FileText{
		Path: "note.txt", Text: "original", Revision: "r1", Writable: true,
	})
	a.fileEdit.text.Set("unsaved draft")
	a.fileEdit.open.Set(true)
	a.submitFileEdit()
	save := nextMobileFileRequest(t, requests)
	if save.method != http.MethodPost || save.write.Text != "unsaved draft" {
		t.Fatalf("save request = %+v, want the current editor text", save)
	}

	a.disconnectWith("left server")
	if !a.fileOpen.GetUntracked() || !a.fileEdit.open.GetUntracked() || a.fileEdit.text.GetUntracked() != "unsaved draft" {
		t.Fatalf("disconnect discarded the editor draft: view=%v editor=%v text=%q", a.fileOpen.GetUntracked(), a.fileEdit.open.GetUntracked(), a.fileEdit.text.GetUntracked())
	}
	if a.fileEdit.saving.GetUntracked() || a.fileEdit.writable.GetUntracked() || a.fileEdit.revision.GetUntracked() != "" || a.fileBusy.GetUntracked() || a.fileEdit.err.GetUntracked() == "" {
		t.Fatalf("disconnect left a stale save capability: saving=%v writable=%v revision=%q reading=%v error=%q",
			a.fileEdit.saving.GetUntracked(), a.fileEdit.writable.GetUntracked(), a.fileEdit.revision.GetUntracked(), a.fileBusy.GetUntracked(), a.fileEdit.err.GetUntracked())
	}

	replyMobileFileRequest(t, posts, save, http.StatusOK, remotewire.FileText{Revision: "r2"})
	if a.fileEdit.text.GetUntracked() != "unsaved draft" || a.fileEdit.revision.GetUntracked() != "" || a.fileEdit.writable.GetUntracked() {
		t.Fatal("late save response changed the disconnected editor")
	}
	current, _ := newMobileFilesTestServer(t)
	a.client = current
	a.submitFileEdit()
	if a.fileEdit.saving.GetUntracked() || a.fileEdit.text.GetUntracked() != "unsaved draft" {
		t.Fatal("draft from the disconnected computer was submitted or lost")
	}
}
