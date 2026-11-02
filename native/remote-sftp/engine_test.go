package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
)

type fakeInfo struct {
	name    string
	size    int64
	mode    os.FileMode
	modTime time.Time
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64        { return f.size }
func (f fakeInfo) Mode() os.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return f.modTime }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return nil }

type fakeNode struct {
	mode    os.FileMode
	data    []byte
	modTime time.Time
}

type fakeRemote struct {
	nodes       map[string]fakeNode
	extensions  map[string]string
	closed      bool
	renameErr   error
	statErr     error
	afterRename bool
}

func newFakeRemote(root string) *fakeRemote {
	return &fakeRemote{
		nodes: map[string]fakeNode{
			root: {mode: os.ModeDir | 0o755, modTime: time.Unix(100, 0)},
		},
		extensions: map[string]string{
			"fsync@openssh.com":        "1",
			"posix-rename@openssh.com": "1",
		},
	}
}

func (f *fakeRemote) RealPath(value string) (string, error) {
	value = path.Clean(value)
	if value == "." {
		return "/home/test", nil
	}
	if _, ok := f.nodes[value]; !ok {
		return "", os.ErrNotExist
	}
	return value, nil
}

func (f *fakeRemote) Lstat(value string) (os.FileInfo, error) {
	if f.afterRename && f.statErr != nil {
		return nil, f.statErr
	}
	node, ok := f.nodes[path.Clean(value)]
	if !ok {
		return nil, os.ErrNotExist
	}
	return fakeInfo{name: path.Base(value), size: int64(len(node.data)), mode: node.mode, modTime: node.modTime}, nil
}

func (f *fakeRemote) ReadDir(value string) ([]os.FileInfo, error) {
	value = path.Clean(value)
	dir, ok := f.nodes[value]
	if !ok {
		return nil, os.ErrNotExist
	}
	if !dir.mode.IsDir() {
		return nil, errors.New("not a directory")
	}
	var result []os.FileInfo
	for name, node := range f.nodes {
		if name == value || path.Dir(name) != value {
			continue
		}
		result = append(result, fakeInfo{name: path.Base(name), size: int64(len(node.data)), mode: node.mode, modTime: node.modTime})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name() < result[right].Name() })
	return result, nil
}

func (f *fakeRemote) OpenRead(value string) (io.ReadCloser, error) {
	node, ok := f.nodes[path.Clean(value)]
	if !ok {
		return nil, os.ErrNotExist
	}
	if !node.mode.IsRegular() {
		return nil, errors.New("not a file")
	}
	return io.NopCloser(bytes.NewReader(append([]byte(nil), node.data...))), nil
}

func (f *fakeRemote) OpenExclusive(value string, mode os.FileMode) (remoteWriteFile, error) {
	value = path.Clean(value)
	if _, ok := f.nodes[value]; ok {
		return nil, errors.New("exists")
	}
	if parent, ok := f.nodes[path.Dir(value)]; !ok || !parent.mode.IsDir() {
		return nil, os.ErrNotExist
	}
	f.nodes[value] = fakeNode{mode: mode, modTime: time.Unix(200, 0)}
	return &fakeWriteFile{remote: f, name: value}, nil
}

func (f *fakeRemote) Rename(oldPath, newPath string) error {
	if f.renameErr != nil {
		return f.renameErr
	}
	oldPath = path.Clean(oldPath)
	newPath = path.Clean(newPath)
	node, ok := f.nodes[oldPath]
	if !ok {
		return os.ErrNotExist
	}
	if _, exists := f.nodes[newPath]; exists {
		return errors.New("target exists")
	}
	delete(f.nodes, oldPath)
	f.nodes[newPath] = node
	f.afterRename = true
	return nil
}

func (f *fakeRemote) Remove(value string) error {
	value = path.Clean(value)
	if _, ok := f.nodes[value]; !ok {
		return os.ErrNotExist
	}
	delete(f.nodes, value)
	return nil
}

func (f *fakeRemote) HasExtension(name string) (string, bool) {
	value, ok := f.extensions[name]
	return value, ok
}

func (f *fakeRemote) Close() error {
	f.closed = true
	return nil
}

type fakeWriteFile struct {
	remote *fakeRemote
	name   string
	closed bool
}

func (f *fakeWriteFile) Write(value []byte) (int, error) {
	if f.closed {
		return 0, errors.New("closed")
	}
	node := f.remote.nodes[f.name]
	node.data = append(node.data, value...)
	f.remote.nodes[f.name] = node
	return len(value), nil
}

func (f *fakeWriteFile) Chmod(mode os.FileMode) error {
	node := f.remote.nodes[f.name]
	node.mode = mode
	f.remote.nodes[f.name] = node
	return nil
}

func (f *fakeWriteFile) Sync() error { return nil }

func (f *fakeWriteFile) Close() error {
	f.closed = true
	return nil
}

func TestDecodeRequestRejectsTraversalAndUnknownFields(t *testing.T) {
	valid := `{
		"version":1,
		"operation":"list",
		"ssh":{"executable":"C:\\Windows\\System32\\OpenSSH\\ssh.exe","args":["-T","-s","host","sftp"],"env":{"SystemRoot":"C:\\Windows"}},
		"root":"/srv/project",
		"relative":"src",
		"maxEntries":10
	}`
	value, err := decodeRequest(strings.NewReader(valid))
	if err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	if value.Root != "/srv/project" || value.Relative != "src" || value.MaxEntries != 10 {
		t.Fatalf("unexpected request: %#v", value)
	}

	for name, body := range map[string]string{
		"traversal": strings.Replace(valid, `"src"`, `"../secret"`, 1),
		"absolute":  strings.Replace(valid, `"src"`, `"/etc"`, 1),
		"unknown":   strings.Replace(valid, `"maxEntries":10`, `"maxEntries":10,"future":true`, 1),
		"version":   strings.Replace(valid, `"version":1`, `"version":2`, 1),
		"overwrite": strings.Replace(valid, `"operation":"list"`, `"operation":"upload"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeRequest(strings.NewReader(body)); err == nil {
				t.Fatal("invalid request was accepted")
			}
		})
	}
}

func TestListIsSortedAndReportsBoundedResult(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	remote.nodes["/srv/project/b.txt"] = fakeNode{mode: 0o644, data: []byte("bb"), modTime: time.Unix(3, 0)}
	remote.nodes["/srv/project/a.txt"] = fakeNode{mode: 0o644, data: []byte("a"), modTime: time.Unix(2, 0)}
	remote.nodes["/srv/project/nested"] = fakeNode{mode: os.ModeDir | 0o755, modTime: time.Unix(1, 0)}

	result, err := executeJob(remote, request{
		Version:    1,
		Operation:  "list",
		Root:       "/srv/project",
		Relative:   "",
		MaxEntries: 2,
		ChunkBytes: 64 * 1024,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	list := result.(listResult)
	if !list.Truncated || list.Scanned != 3 || len(list.Entries) != 2 {
		t.Fatalf("unexpected bounded list: %#v", list)
	}
	if list.Entries[0].Name != "a.txt" || list.Entries[1].Name != "b.txt" {
		t.Fatalf("entries are not sorted deterministically: %#v", list.Entries)
	}
}

func TestListRejectsSymlinkAndNonDirectory(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	remote.nodes["/srv/project/link"] = fakeNode{mode: os.ModeSymlink | 0o777}
	remote.nodes["/srv/project/file.txt"] = fakeNode{mode: 0o644, data: []byte("x")}

	for relative, wantCode := range map[string]string{
		"link":     "SFTP_SYMLINK_REJECTED",
		"file.txt": "SFTP_NOT_A_DIRECTORY",
	} {
		_, err := executeJob(remote, request{
			Operation:  "list",
			Root:       "/srv/project",
			Relative:   relative,
			MaxEntries: 10,
			ChunkBytes: 64 * 1024,
		}, nil)
		if codeOf(err) != wantCode {
			t.Fatalf("%s: got %v, want %s", relative, err, wantCode)
		}
	}
}

func TestDownloadStreamsToNewLocalFileAndReportsBytes(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	content := bytes.Repeat([]byte("0123456789"), 10000)
	remote.nodes["/srv/project/asset.bin"] = fakeNode{mode: 0o644, data: content, modTime: time.Unix(20, 0)}
	directory := t.TempDir()
	destination := filepath.Join(directory, "asset.bin")
	var progress []int64
	result, err := executeJob(remote, request{
		Operation:  "download",
		Root:       "/srv/project",
		Relative:   "asset.bin",
		LocalPath:  destination,
		ChunkBytes: 64 * 1024,
	}, func(transferred, _ int64) {
		progress = append(progress, transferred)
	})
	if err != nil {
		t.Fatal(err)
	}
	bytesWritten, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytesWritten, content) || result.(transferResult).Bytes != int64(len(content)) {
		t.Fatal("downloaded bytes do not match")
	}
	if len(progress) == 0 || progress[len(progress)-1] != int64(len(content)) {
		t.Fatalf("progress did not reach total: %#v", progress)
	}
}

func TestDownloadRejectsSymlinkAndExistingLocalFile(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	remote.nodes["/srv/project/link"] = fakeNode{mode: os.ModeSymlink | 0o777}
	remote.nodes["/srv/project/file"] = fakeNode{mode: 0o644, data: []byte("x")}
	existing := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(existing, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := executeJob(remote, request{Operation: "download", Root: "/srv/project", Relative: "file", LocalPath: existing, ChunkBytes: 64 * 1024}, nil); codeOf(err) != "SFTP_LOCAL_EXISTS" {
		t.Fatalf("existing local target accepted: %v", err)
	}
	if _, err := executeJob(remote, request{Operation: "download", Root: "/srv/project", Relative: "link", LocalPath: filepath.Join(t.TempDir(), "new"), ChunkBytes: 64 * 1024}, nil); codeOf(err) != "SFTP_SYMLINK_REJECTED" {
		t.Fatalf("symlink accepted: %v", err)
	}
}

func TestUploadStreamsAndCommitsWithoutReplacingExistingTarget(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	source := filepath.Join(t.TempDir(), "source.bin")
	content := bytes.Repeat([]byte("abcdef"), 10000)
	if err := os.WriteFile(source, content, 0o600); err != nil {
		t.Fatal(err)
	}
	var progress []int64
	result, err := executeJob(remote, request{
		Operation:  "upload",
		Root:       "/srv/project",
		Relative:   "source.bin",
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, func(transferred, _ int64) {
		progress = append(progress, transferred)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(remote.nodes["/srv/project/source.bin"].data, content) {
		t.Fatal("uploaded bytes do not match")
	}
	if len(progress) == 0 || progress[len(progress)-1] != int64(len(content)) || result.(transferResult).Bytes != int64(len(content)) {
		t.Fatal("upload progress or result size is wrong")
	}
	for name := range remote.nodes {
		if strings.Contains(name, ".pideck-part-") {
			t.Fatalf("temporary remote file was not removed: %s", name)
		}
	}

	_, err = executeJob(remote, request{Operation: "upload", Root: "/srv/project", Relative: "source.bin", LocalPath: source, ChunkBytes: 64 * 1024}, nil)
	if codeOf(err) != "SFTP_REMOTE_EXISTS" {
		t.Fatalf("overwrite was not rejected: %v", err)
	}
}

func TestUploadRejectsSymlinkParent(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	remote.nodes["/srv/project/link"] = fakeNode{mode: os.ModeSymlink | 0o777}
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := executeJob(remote, request{Operation: "upload", Root: "/srv/project", Relative: "link/file", LocalPath: source, ChunkBytes: 64 * 1024}, nil)
	if codeOf(err) != "SFTP_SYMLINK_REJECTED" {
		t.Fatalf("symlink parent accepted: %v", err)
	}
}

func TestUploadCommitResultIsNotMisreportedAfterRename(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}

	remote.renameErr = sftp.ErrSSHFxConnectionLost
	_, err := executeJob(remote, request{Operation: "upload", Root: "/srv/project", Relative: "source", LocalPath: source, ChunkBytes: 64 * 1024}, nil)
	if codeOf(err) != "SFTP_REMOTE_COMMIT_UNKNOWN" {
		t.Fatalf("lost rename response was not unknown: %v", err)
	}

	remote.renameErr = nil
	remote.statErr = sftp.ErrSSHFxConnectionLost
	result, err := executeJob(remote, request{Operation: "upload", Root: "/srv/project", Relative: "source", LocalPath: source, ChunkBytes: 64 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	transfer := result.(transferResult)
	if transfer.Bytes != int64(len("content")) || transfer.MtimeMs != 0 || transfer.AtomicRename {
		t.Fatalf("post-rename stat failure corrupted the committed result: %#v", transfer)
	}
}

func TestProbeReportsCapabilities(t *testing.T) {
	remote := newFakeRemote("/srv/project")
	result, err := executeJob(remote, request{Operation: "probe", Root: "/srv/project", ChunkBytes: 64 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	probe := result.(probeResult)
	if probe.ProtocolVersion != 1 || probe.Extensions["fsync@openssh.com"] != "1" {
		t.Fatalf("unexpected probe: %#v", probe)
	}
}
