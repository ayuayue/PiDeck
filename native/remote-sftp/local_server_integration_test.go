package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pkg/sftp"
)

// localSftpRoot exposes an absolute local directory as the absolute path shape
// the SFTP server accepts on both POSIX and Windows.
func localSftpRoot(t *testing.T, directory string) string {
	t.Helper()
	absolute, err := filepath.Abs(directory)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		t.Fatal(err)
	}
	slash := filepath.ToSlash(canonical)
	if runtime.GOOS == "windows" {
		if len(slash) < 2 || slash[1] != ':' {
			t.Fatalf("unexpected Windows test path: %s", slash)
		}
		return "/" + slash
	}
	return slash
}

func newLocalSftpRemote(t *testing.T) (*sftpRemoteClient, func()) {
	t.Helper()
	serverSide, clientSide := net.Pipe()
	server, err := sftp.NewServer(serverSide)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = server.Serve()
	}()
	bounded := newBoundedPacketReader(clientSide)
	client, err := sftp.NewClientPipe(bounded, clientSide)
	if err != nil {
		_ = server.Close()
		_ = serverSide.Close()
		_ = clientSide.Close()
		t.Fatal(err)
	}
	return &sftpRemoteClient{client: client, bounded: bounded}, func() {
		_ = client.Close()
		_ = server.Close()
		_ = clientSide.Close()
		_ = serverSide.Close()
	}
}

func TestLocalServerRoundTripsEmptyBinaryUnicodeAndLargeFiles(t *testing.T) {
	directory := t.TempDir()
	root := localSftpRoot(t, directory)
	remote, closeRemote := newLocalSftpRemote(t)
	defer closeRemote()

	if _, err := executeJob(remote, request{Operation: "probe", Root: root, ChunkBytes: 64 * 1024}, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "空 格.bin"), []byte{0, 1, 2, 0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := executeJob(remote, request{
		Operation:  "download",
		Root:       root,
		Relative:   "空 格.bin",
		LocalPath:  filepath.Join(t.TempDir(), "downloaded.bin"),
		ChunkBytes: 64 * 1024,
	}, nil); err != nil {
		t.Fatal(err)
	}

	large := bytes.Repeat([]byte{0x00, 0x5a, 0xff, 0x31}, (17*1024*1024)/4)
	source := filepath.Join(t.TempDir(), "large.bin")
	if err := os.WriteFile(source, large, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := executeJob(remote, request{
		Operation:  "upload",
		Root:       root,
		Relative:   "上传 large.bin",
		LocalPath:  source,
		ChunkBytes: 1024 * 1024,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.(transferResult).Bytes != int64(len(large)) {
		t.Fatalf("unexpected upload size: %#v", result)
	}
	got, err := os.ReadFile(filepath.Join(directory, "上传 large.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, large) {
		t.Fatal("large upload bytes do not match")
	}
}

func TestLocalServerListReportsSortingAndTruncation(t *testing.T) {
	directory := t.TempDir()
	root := localSftpRoot(t, directory)
	for index := 0; index < 1005; index++ {
		name := "entry-" + numberName(index)
		if err := os.WriteFile(filepath.Join(directory, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(directory, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	remote, closeRemote := newLocalSftpRemote(t)
	defer closeRemote()

	result, err := executeJob(remote, request{
		Operation:  "list",
		Root:       root,
		Relative:   "",
		MaxEntries: 1000,
		ChunkBytes: 64 * 1024,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	list := result.(listResult)
	if !list.Truncated || list.Scanned != 1006 || len(list.Entries) != 1000 {
		t.Fatalf("unexpected local server list result: scanned=%d truncated=%v entries=%d", list.Scanned, list.Truncated, len(list.Entries))
	}
	if list.Entries[0].Name != "entry-0000" || list.Entries[999].Name != "entry-0999" {
		t.Fatalf("local server list is not sorted: first=%q last=%q", list.Entries[0].Name, list.Entries[999].Name)
	}
}

func TestLocalServerStageWritesOnlyHelperSpool(t *testing.T) {
	directory := t.TempDir()
	root := localSftpRoot(t, directory)
	spool := filepath.Join(directory, "upload-spool")
	if err := os.Mkdir(spool, 0o700); err != nil {
		t.Fatal(err)
	}
	remote, closeRemote := newLocalSftpRemote(t)
	defer closeRemote()

	content := bytes.Repeat([]byte{0x00, 0x51, 0xff, 0x7e}, 32*1024)
	source := filepath.Join(t.TempDir(), "source.bin")
	if err := os.WriteFile(source, content, 0o600); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("b", 32)
	relative := "upload-spool/" + id + ".part"
	result, err := executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	stage := result.(stageResult)
	expectedHash := sha256.Sum256(content)
	if stage.Bytes != int64(len(content)) || stage.Sha256 != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("unexpected local server stage result: %#v", stage)
	}
	stagedPath := filepath.Join(spool, id+".part")
	staged, err := os.ReadFile(stagedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(staged, content) {
		t.Fatal("local server staged bytes do not match")
	}
	if _, err := os.Lstat(filepath.Join(directory, "published.bin")); !os.IsNotExist(err) {
		t.Fatalf("stage published a user-visible target: %v", err)
	}

	_, err = executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   relative,
		LocalPath:  source,
		ChunkBytes: 64 * 1024,
	}, nil)
	if codeOf(err) != "SFTP_REMOTE_EXISTS" {
		t.Fatalf("repeated local server stage did not reject a live spool: %v", err)
	}

	emptySource := filepath.Join(t.TempDir(), "empty.bin")
	if err := os.WriteFile(emptySource, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	emptyID := strings.Repeat("c", 32)
	result, err = executeJob(remote, request{
		Operation:  "stage",
		Root:       root,
		Relative:   "upload-spool/" + emptyID + ".part",
		LocalPath:  emptySource,
		ChunkBytes: 64 * 1024,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	emptyStage := result.(stageResult)
	emptyHash := sha256.Sum256(nil)
	if emptyStage.Bytes != 0 || emptyStage.Sha256 != hex.EncodeToString(emptyHash[:]) {
		t.Fatalf("unexpected empty local server stage result: %#v", emptyStage)
	}
}

func numberName(value int) string {
	return string([]byte{byte('0' + value/1000), byte('0' + (value/100)%10), byte('0' + (value/10)%10), byte('0' + value%10)})
}
