package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	nodes             map[string]fakeNode
	extensions        map[string]string
	closed            bool
	renameErr         error
	statErr           error
	openExclusiveErr  error
	createOnOpenError bool
	writeErr          error
	afterRename       bool
	renameCalls       int
	syncCalls         map[string]int
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
		syncCalls: map[string]int{},
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
	if f.openExclusiveErr != nil {
		if f.createOnOpenError {
			f.nodes[value] = fakeNode{mode: mode, modTime: time.Unix(200, 0)}
		}
		return nil, f.openExclusiveErr
	}
	if _, ok := f.nodes[value]; ok {
		return nil, os.ErrExist
	}
	if parent, ok := f.nodes[path.Dir(value)]; !ok || !parent.mode.IsDir() {
		return nil, os.ErrNotExist
	}
	f.nodes[value] = fakeNode{mode: mode, modTime: time.Unix(200, 0)}
	return &fakeWriteFile{remote: f, name: value, writeErr: f.writeErr}, nil
}

func (f *fakeRemote) Rename(oldPath, newPath string) error {
	f.renameCalls++
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
	remote   *fakeRemote
	name     string
	writeErr error
	closed   bool
}

func (f *fakeWriteFile) Write(value []byte) (int, error) {
	if f.closed {
		return 0, errors.New("closed")
	}
	if f.writeErr != nil {
		return 0, f.writeErr
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

func (f *fakeWriteFile) Sync() error {
	f.remote.syncCalls[f.name]++
	return nil
}

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

func TestDecodeRequestAcceptsOnlyCanonicalStageRequest(t *testing.T) {
	local := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(local, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	base := map[string]any{
		"version":   1,
		"operation": "stage",
		"ssh": map[string]any{
			"executable": filepath.Join(t.TempDir(), "ssh"),
			"args":       []string{"-T", "-s", "host", "sftp"},
			"env":        map[string]string{},
		},
		"root":       "/srv/project",
		"relative":   "upload-spool/" + id + ".part",
		"localPath":  local,
		"chunkBytes": 64 * 1024,
	}

	valid, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeRequest(bytes.NewReader(valid))
	if err != nil {
		t.Fatalf("valid stage request rejected: %v", err)
	}
	if decoded.Operation != "stage" || decoded.Relative != base["relative"] {
		t.Fatalf("unexpected decoded stage request: %#v", decoded)
	}

	for name, test := range map[string]struct {
		change   func(map[string]any)
		wantCode string
	}{
		"absolute": {
			change:   func(value map[string]any) { value["relative"] = "/upload-spool/" + id + ".part" },
			wantCode: "SFTP_STAGE_PATH_INVALID",
		},
		"traversal": {
			change:   func(value map[string]any) { value["relative"] = "../upload-spool/" + id + ".part" },
			wantCode: "SFTP_STAGE_PATH_INVALID",
		},
		"wrong parent": {
			change:   func(value map[string]any) { value["relative"] = "other/" + id + ".part" },
			wantCode: "SFTP_STAGE_PATH_INVALID",
		},
		"short id": {
			change:   func(value map[string]any) { value["relative"] = "upload-spool/" + strings.Repeat("a", 31) + ".part" },
			wantCode: "SFTP_STAGE_PATH_INVALID",
		},
		"uppercase id": {
			change:   func(value map[string]any) { value["relative"] = "upload-spool/" + strings.Repeat("A", 32) + ".part" },
			wantCode: "SFTP_STAGE_PATH_INVALID",
		},
		"overwrite": {
			change:   func(value map[string]any) { value["overwrite"] = true },
			wantCode: "SFTP_OVERWRITE_UNSUPPORTED",
		},
		"relative source": {
			change:   func(value map[string]any) { value["localPath"] = "source.bin" },
			wantCode: "SFTP_LOCAL_PATH_INVALID",
		},
	} {
		t.Run(name, func(t *testing.T) {
			value := make(map[string]any, len(base))
			for key, item := range base {
				value[key] = item
			}
			test.change(value)
			body, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeRequest(bytes.NewReader(body)); codeOf(err) != test.wantCode {
				t.Fatalf("invalid stage request returned %v, want %s", err, test.wantCode)
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

func TestStageWritesOnlyExclusiveSpoolAndReturnsDigest(t *testing.T) {
	const root = "/srv/project"
	id := strings.Repeat("1", 32)
	relative := "upload-spool/" + id + ".part"
	target := root + "/" + relative
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}

	content := bytes.Repeat([]byte("stage-byte-"), 10000)
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, content, 0o600); err != nil {
		t.Fatal(err)
	}
	var progress []int64
	result, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, func(transferred, _ int64) {
		progress = append(progress, transferred)
	})
	if err != nil {
		t.Fatal(err)
	}
	stage := result.(stageResult)
	expectedHash := sha256.Sum256(content)
	if stage.Bytes != int64(len(content)) ||
		stage.Sha256 != hex.EncodeToString(expectedHash[:]) ||
		!stage.Fsync {
		t.Fatalf("unexpected stage result: %#v", stage)
	}
	staged, ok := remote.nodes[target]
	if !ok || !bytes.Equal(staged.data, content) || staged.mode.Perm() != 0o600 {
		t.Fatalf("stage bytes or mode do not match: %#v", staged)
	}
	if remote.renameCalls != 0 {
		t.Fatalf("stage unexpectedly renamed a file %d times", remote.renameCalls)
	}
	if remote.syncCalls[target] != 1 {
		t.Fatalf("stage did not fsync the advertised extension target: %#v", remote.syncCalls)
	}
	if _, published := remote.nodes[root+"/source.bin"]; published {
		t.Fatal("stage published a user-visible target")
	}
	if len(progress) == 0 || progress[len(progress)-1] != int64(len(content)) {
		t.Fatalf("stage progress did not reach total: %#v", progress)
	}
}

func TestStageSupportsEmptyFileWithoutFakeFsync(t *testing.T) {
	const root = "/srv/project"
	id := strings.Repeat("2", 32)
	relative := "upload-spool/" + id + ".part"
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	delete(remote.extensions, "fsync@openssh.com")
	source := filepath.Join(t.TempDir(), "empty.bin")
	if err := os.WriteFile(source, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var progress [][2]int64
	result, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, func(transferred, total int64) {
		progress = append(progress, [2]int64{transferred, total})
	})
	if err != nil {
		t.Fatal(err)
	}
	stage := result.(stageResult)
	emptyHash := sha256.Sum256(nil)
	if stage.Bytes != 0 || stage.Sha256 != hex.EncodeToString(emptyHash[:]) || stage.Fsync {
		t.Fatalf("unexpected empty stage result: %#v", stage)
	}
	if remote.syncCalls[root+"/"+relative] != 0 {
		t.Fatal("stage called Sync without advertising fsync")
	}
	if len(progress) != 1 || progress[0] != [2]int64{0, 0} {
		t.Fatalf("empty stage progress mismatch: %#v", progress)
	}
}

func TestStageRejectsNonCanonicalSpoolPaths(t *testing.T) {
	const root = "/srv/project"
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	for name, relative := range map[string]string{
		"absolute":     "/upload-spool/" + id + ".part",
		"traversal":    "../upload-spool/" + id + ".part",
		"wrong parent": "other/" + id + ".part",
		"short id":     "upload-spool/" + strings.Repeat("a", 31) + ".part",
		"uppercase id": "upload-spool/" + strings.Repeat("A", 32) + ".part",
		"nested":       "upload-spool/nested/" + id + ".part",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := executeJob(remote, request{
				Operation:  "stage",
				Root:       root,
				Relative:   relative,
				LocalPath:  source,
				ChunkBytes: 64 * 1024,
			}, nil)
			if codeOf(err) != "SFTP_STAGE_PATH_INVALID" {
				t.Fatalf("invalid path %q returned %v", relative, err)
			}
		})
	}
	if remote.renameCalls != 0 {
		t.Fatal("invalid stage path triggered rename")
	}
}

func TestStageRejectsExistingTargetAndOpenRace(t *testing.T) {
	const root = "/srv/project"
	id := strings.Repeat("3", 32)
	relative := "upload-spool/" + id + ".part"
	target := root + "/" + relative
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}

	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	remote.nodes[target] = fakeNode{mode: 0o600, data: []byte("keep"), modTime: time.Unix(11, 0)}
	_, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, nil)
	if codeOf(err) != "SFTP_REMOTE_EXISTS" || !bytes.Equal(remote.nodes[target].data, []byte("keep")) {
		t.Fatalf("existing stage target was not preserved: %v", err)
	}

	race := newFakeRemote(root)
	race.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	race.openExclusiveErr = errors.New("generic SFTP failure")
	race.createOnOpenError = true
	_, err = executeJob(race, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, nil)
	if codeOf(err) != "SFTP_REMOTE_EXISTS" {
		t.Fatalf("generic exclusive create race was not reported as exists: %v", err)
	}
}

func TestStageRejectsSymlinkParent(t *testing.T) {
	const root = "/srv/project"
	id := strings.Repeat("4", 32)
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeSymlink | 0o777, modTime: time.Unix(10, 0)}
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   "upload-spool/" + id + ".part",
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, nil)
	if codeOf(err) != "SFTP_SYMLINK_REJECTED" {
		t.Fatalf("symlink stage parent accepted: %v", err)
	}
}

func TestStageRejectsNonRegularLocalSource(t *testing.T) {
	const root = "/srv/project"
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	directory := t.TempDir()
	_, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   "upload-spool/" + strings.Repeat("5", 32) + ".part",
		LocalPath:  directory,
		ChunkBytes: 64 * 1024,
	}, nil)
	if codeOf(err) != "SFTP_LOCAL_NOT_A_FILE" {
		t.Fatalf("directory source accepted: %v", err)
	}
}

func TestStageDetectsChangedLocalSourceAndCleansSpool(t *testing.T) {
	const root = "/srv/project"
	id := strings.Repeat("6", 32)
	relative := "upload-spool/" + id + ".part"
	target := root + "/" + relative
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, bytes.Repeat([]byte("x"), 256*1024), 0o600); err != nil {
		t.Fatal(err)
	}
	var mutationErr error
	mutated := false
	_, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, func(int64, int64) {
		if mutated {
			return
		}
		mutated = true
		changed := time.Now().Add(2 * time.Second)
		mutationErr = os.Chtimes(source, changed, changed)
	})
	if mutationErr != nil {
		t.Fatal(mutationErr)
	}
	if !mutated {
		t.Fatal("stage never reported progress, source was not changed")
	}
	if codeOf(err) != "SFTP_LOCAL_FILE_CHANGED" {
		t.Fatalf("changed source was not rejected: %v", err)
	}
	if _, exists := remote.nodes[target]; exists {
		t.Fatal("failed stage left a spool file behind")
	}
}

func TestStageCleansSpoolAfterWriteFailure(t *testing.T) {
	const root = "/srv/project"
	id := strings.Repeat("7", 32)
	relative := "upload-spool/" + id + ".part"
	target := root + "/" + relative
	remote := newFakeRemote(root)
	remote.nodes[root+"/upload-spool"] = fakeNode{mode: os.ModeDir | 0o700, modTime: time.Unix(10, 0)}
	remote.writeErr = errors.New("remote write failed")
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, nil)
	if codeOf(err) != "SFTP_REMOTE_IO_FAILED" {
		t.Fatalf("write failure returned %v", err)
	}
	if _, exists := remote.nodes[target]; exists {
		t.Fatal("failed stage left a spool file behind")
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
