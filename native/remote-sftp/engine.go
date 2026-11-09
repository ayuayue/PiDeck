package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

type progressFunc func(transferred, total int64)

type remoteEntry struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Bytes     int64  `json:"bytes,omitempty"`
	MtimeMs   int64  `json:"mtimeMs,omitempty"`
	IsSymlink bool   `json:"isSymlink"`
}

type listResult struct {
	Entries   []remoteEntry `json:"entries"`
	Scanned   int           `json:"scanned"`
	Truncated bool          `json:"truncated"`
}

type probeResult struct {
	ProtocolVersion int               `json:"protocolVersion"`
	Root            string            `json:"root"`
	Home            string            `json:"home,omitempty"`
	Extensions      map[string]string `json:"extensions"`
}

type transferResult struct {
	Bytes        int64 `json:"bytes"`
	MtimeMs      int64 `json:"mtimeMs,omitempty"`
	Fsync        bool  `json:"fsync"`
	AtomicRename bool  `json:"atomicRename"`
}

type stageResult struct {
	Bytes  int64  `json:"bytes"`
	Sha256 string `json:"sha256"`
	Fsync  bool   `json:"fsync"`
}

type remoteWriteFile interface {
	io.Writer
	io.Closer
	Chmod(os.FileMode) error
	Sync() error
}

type remoteClient interface {
	RealPath(string) (string, error)
	Lstat(string) (os.FileInfo, error)
	ReadDirBounded(string, int) ([]os.FileInfo, bool, int, error)
	OpenRead(string) (io.ReadCloser, error)
	OpenExclusive(string, os.FileMode) (remoteWriteFile, error)
	Rename(string, string) error
	Remove(string) error
	HasExtension(string) (string, bool)
	Close() error
}

type sftpRemoteClient struct {
	client  *sftp.Client
	bounded *boundedPacketReader
}

func (c *sftpRemoteClient) RealPath(value string) (string, error)   { return c.client.RealPath(value) }
func (c *sftpRemoteClient) Lstat(value string) (os.FileInfo, error) { return c.client.Lstat(value) }
func (c *sftpRemoteClient) ReadDirBounded(value string, maxEntries int) ([]os.FileInfo, bool, int, error) {
	if c.bounded == nil {
		return nil, false, 0, fail("SFTP_LIST_UNAVAILABLE", nil)
	}
	c.bounded.begin(maxEntries)
	items, err := c.client.ReadDirContext(context.Background(), value)
	observed, truncated, terminal := c.bounded.end()
	if terminal != nil {
		if truncated && errors.Is(terminal, errBoundedDirectory) {
			return items, true, observed, nil
		}
		return nil, false, observed, terminal
	}
	if err != nil {
		return nil, false, observed, err
	}
	return items, truncated || len(items) > maxEntries, observed, nil
}
func (c *sftpRemoteClient) OpenRead(value string) (io.ReadCloser, error) { return c.client.Open(value) }
func (c *sftpRemoteClient) Rename(oldPath, newPath string) error {
	return c.client.Rename(oldPath, newPath)
}
func (c *sftpRemoteClient) Remove(value string) error { return c.client.Remove(value) }
func (c *sftpRemoteClient) HasExtension(name string) (string, bool) {
	return c.client.HasExtension(name)
}
func (c *sftpRemoteClient) Close() error { return c.client.Close() }
func (c *sftpRemoteClient) OpenExclusive(value string, mode os.FileMode) (remoteWriteFile, error) {
	// SFTP v3 has no O_NOFOLLOW flag. O_EXCL rejects an existing leaf, including
	// a symlink; stageRemote separately rejects every existing ancestor symlink
	// before opening and again before reporting success.
	file, err := c.client.OpenFile(value, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		_ = c.client.Remove(value)
		return nil, err
	}
	return file, nil
}

func executeJob(client remoteClient, value request, progress progressFunc) (any, error) {
	if err := ensureCanonicalRoot(client, value.Root); err != nil {
		return nil, err
	}
	switch value.Operation {
	case "probe":
		return probeRemote(client, value.Root)
	case "list":
		return listRemote(client, value)
	case "download":
		return downloadRemote(client, value, progress)
	case "upload":
		return uploadRemote(client, value, progress)
	case "stage":
		return stageRemote(client, value, progress)
	default:
		return nil, fail("SFTP_OPERATION_INVALID", nil)
	}
}

func ensureCanonicalRoot(client remoteClient, root string) error {
	realRoot, err := client.RealPath(root)
	if err != nil {
		return mapRemoteError(err)
	}
	cleanRoot := path.Clean(realRoot)
	if cleanRoot != root {
		return fail("SFTP_REMOTE_ROOT_CHANGED", nil)
	}
	info, err := client.Lstat(root)
	if err != nil {
		return mapRemoteError(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fail("SFTP_REMOTE_ROOT_CHANGED", nil)
	}
	return nil
}

func probeRemote(client remoteClient, root string) (probeResult, error) {
	extensions := map[string]string{}
	for _, name := range []string{"posix-rename@openssh.com", "fsync@openssh.com", "statvfs@openssh.com"} {
		if version, ok := client.HasExtension(name); ok {
			extensions[name] = version
		}
	}
	home, _ := client.RealPath(".")
	return probeResult{
		ProtocolVersion: protocolVersion,
		Root:            root,
		Home:            home,
		Extensions:      extensions,
	}, nil
}

func listRemote(client remoteClient, value request) (listResult, error) {
	target, err := remoteChild(value.Root, value.Relative)
	if err != nil {
		return listResult{}, err
	}
	if err := assertNoSymlinkPath(client, value.Root, value.Relative, true); err != nil {
		return listResult{}, err
	}
	info, err := client.Lstat(target)
	if err != nil {
		return listResult{}, mapRemoteError(err)
	}
	if !info.IsDir() {
		return listResult{}, fail("SFTP_NOT_A_DIRECTORY", nil)
	}
	items, truncated, scanned, err := client.ReadDirBounded(target, value.MaxEntries)
	if err != nil {
		return listResult{}, mapRemoteError(err)
	}
	sort.Slice(items, func(left, right int) bool { return items[left].Name() < items[right].Name() })
	truncated = truncated || len(items) > value.MaxEntries
	if len(items) > value.MaxEntries {
		items = items[:value.MaxEntries]
	}
	entries := make([]remoteEntry, 0, len(items))
	for _, item := range items {
		kind := "other"
		if item.IsDir() {
			kind = "directory"
		} else if item.Mode().IsRegular() {
			kind = "file"
		}
		entries = append(entries, remoteEntry{
			Name:      item.Name(),
			Kind:      kind,
			Bytes:     item.Size(),
			MtimeMs:   item.ModTime().UnixMilli(),
			IsSymlink: item.Mode()&os.ModeSymlink != 0,
		})
	}
	return listResult{Entries: entries, Scanned: scanned, Truncated: truncated}, nil
}

func downloadRemote(client remoteClient, value request, progress progressFunc) (transferResult, error) {
	target, err := remoteChild(value.Root, value.Relative)
	if err != nil {
		return transferResult{}, err
	}
	if err := assertNoSymlinkParent(client, value.Root, value.Relative); err != nil {
		return transferResult{}, err
	}
	before, err := client.Lstat(target)
	if err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	if before.Mode()&os.ModeSymlink != 0 {
		return transferResult{}, fail("SFTP_SYMLINK_REJECTED", nil)
	}
	if !before.Mode().IsRegular() {
		return transferResult{}, fail("SFTP_NOT_A_FILE", nil)
	}
	remote, err := client.OpenRead(target)
	if err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	defer remote.Close()

	if _, err := os.Lstat(value.LocalPath); err == nil {
		return transferResult{}, fail("SFTP_LOCAL_EXISTS", nil)
	} else if !errors.Is(err, os.ErrNotExist) {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(value.LocalPath), "."+filepath.Base(value.LocalPath)+".pideck-part-*")
	if err != nil {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	reader := newProgressReader(remote, before.Size(), progress)
	written, err := io.CopyBuffer(temp, reader, make([]byte, value.ChunkBytes))
	if err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	if written != before.Size() {
		return transferResult{}, fail("SFTP_REMOTE_FILE_CHANGED", nil)
	}
	after, err := client.Lstat(target)
	if err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	if !sameRemoteFileVersion(before, after) {
		return transferResult{}, fail("SFTP_REMOTE_FILE_CHANGED", nil)
	}
	if err := temp.Sync(); err != nil {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	if err := temp.Close(); err != nil {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	// A hard link publishes the completed inode without replacing a file that
	// appeared after the initial existence check. The temporary name is in the
	// same directory, so both names stay on the same filesystem.
	if err := os.Link(tempPath, value.LocalPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return transferResult{}, fail("SFTP_LOCAL_EXISTS", nil)
		}
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	if err := os.Remove(tempPath); err != nil {
		_ = os.Remove(value.LocalPath)
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	committed = true
	return transferResult{Bytes: written, MtimeMs: after.ModTime().UnixMilli()}, nil
}

func uploadRemote(client remoteClient, value request, progress progressFunc) (transferResult, error) {
	local, err := os.Lstat(value.LocalPath)
	if err != nil {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	if local.Mode()&os.ModeSymlink != 0 || !local.Mode().IsRegular() {
		return transferResult{}, fail("SFTP_LOCAL_NOT_A_FILE", nil)
	}
	target, err := remoteChild(value.Root, value.Relative)
	if err != nil {
		return transferResult{}, err
	}
	if err := assertNoSymlinkParent(client, value.Root, value.Relative); err != nil {
		return transferResult{}, err
	}
	if _, err := client.Lstat(target); err == nil {
		return transferResult{}, fail("SFTP_REMOTE_EXISTS", nil)
	} else if !errors.Is(err, sftp.ErrSSHFxNoSuchFile) && !errors.Is(err, os.ErrNotExist) {
		return transferResult{}, mapRemoteError(err)
	}

	source, err := os.Open(value.LocalPath)
	if err != nil {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	defer source.Close()

	suffix, err := randomSuffix()
	if err != nil {
		return transferResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	remoteTemp := path.Join(path.Dir(target), "."+path.Base(target)+".pideck-part-"+suffix)
	writer, err := client.OpenExclusive(remoteTemp, 0o600)
	if err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	committed := false
	defer func() {
		_ = writer.Close()
		if !committed {
			_ = client.Remove(remoteTemp)
		}
	}()

	reader := newProgressReader(source, local.Size(), progress)
	written, err := io.CopyBuffer(writer, reader, make([]byte, value.ChunkBytes))
	if err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	afterLocal, err := os.Lstat(value.LocalPath)
	if err != nil || !sameLocalFileVersion(local, afterLocal) || written != local.Size() {
		return transferResult{}, fail("SFTP_LOCAL_FILE_CHANGED", nil)
	}
	_, fsyncAvailable := client.HasExtension("fsync@openssh.com")
	if fsyncAvailable {
		if err := writer.Sync(); err != nil {
			return transferResult{}, mapRemoteError(err)
		}
	}
	if err := writer.Close(); err != nil {
		return transferResult{}, mapRemoteError(err)
	}
	if err := client.Rename(remoteTemp, target); err != nil {
		if errors.Is(err, sftp.ErrSSHFxConnectionLost) || errors.Is(err, io.ErrUnexpectedEOF) {
			return transferResult{}, fail("SFTP_REMOTE_COMMIT_UNKNOWN", err)
		}
		return transferResult{}, mapRemoteError(err)
	}
	committed = true
	var mtimeMs int64
	if resultInfo, statErr := client.Lstat(target); statErr == nil {
		mtimeMs = resultInfo.ModTime().UnixMilli()
	}
	return transferResult{
		Bytes:   written,
		MtimeMs: mtimeMs,
		Fsync:   fsyncAvailable,
		// The standard SFTP rename used above has no portable no-clobber or
		// atomicity guarantee. SFTP-1 must define commit semantics with the
		// versioned helper path before uploads become writable in production.
		AtomicRename: false,
	}, nil
}

// stageRemote writes only to the helper-owned spool path. It deliberately has
// no target/publish step: a successful return means the bytes are durable enough
// for the helper commit protocol to verify and publish later.
func stageRemote(client remoteClient, value request, progress progressFunc) (stageResult, error) {
	if !stagePathPattern.MatchString(value.Relative) {
		return stageResult{}, fail("SFTP_STAGE_PATH_INVALID", nil)
	}
	local, err := os.Lstat(value.LocalPath)
	if err != nil {
		return stageResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	if local.Mode()&os.ModeSymlink != 0 || !local.Mode().IsRegular() {
		return stageResult{}, fail("SFTP_LOCAL_NOT_A_FILE", nil)
	}
	source, err := os.Open(value.LocalPath)
	if err != nil {
		return stageResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	defer source.Close()
	openedLocal, err := source.Stat()
	if err != nil {
		return stageResult{}, fail("SFTP_LOCAL_IO_FAILED", err)
	}
	if !os.SameFile(local, openedLocal) || !sameLocalFileVersion(local, openedLocal) {
		return stageResult{}, fail("SFTP_LOCAL_FILE_CHANGED", nil)
	}

	target, err := remoteChild(value.Root, value.Relative)
	if err != nil {
		return stageResult{}, err
	}
	if err := assertNoSymlinkParent(client, value.Root, value.Relative); err != nil {
		return stageResult{}, err
	}
	if _, err := client.Lstat(target); err == nil {
		return stageResult{}, fail("SFTP_REMOTE_EXISTS", nil)
	} else if !errors.Is(err, sftp.ErrSSHFxNoSuchFile) && !errors.Is(err, os.ErrNotExist) {
		return stageResult{}, mapRemoteError(err)
	}

	writer, err := client.OpenExclusive(target, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return stageResult{}, fail("SFTP_REMOTE_EXISTS", nil)
		}
		// SFTP v3 commonly reports an O_EXCL collision as a generic failure.
		// Confirm whether the raced-created leaf now exists before degrading the
		// stable no-clobber result into a remote I/O error.
		if _, statErr := client.Lstat(target); statErr == nil {
			return stageResult{}, fail("SFTP_REMOTE_EXISTS", nil)
		}
		return stageResult{}, mapRemoteError(err)
	}
	committed := false
	defer func() {
		_ = writer.Close()
		if !committed {
			_ = client.Remove(target)
		}
	}()

	hash := sha256.New()
	reader := newProgressReader(source, local.Size(), progress)
	written, err := io.CopyBuffer(writer, io.TeeReader(reader, hash), make([]byte, value.ChunkBytes))
	if err != nil {
		return stageResult{}, mapRemoteError(err)
	}
	afterOpened, openedErr := source.Stat()
	afterLocal, pathErr := os.Lstat(value.LocalPath)
	if openedErr != nil ||
		pathErr != nil ||
		!os.SameFile(local, afterOpened) ||
		!os.SameFile(local, afterLocal) ||
		!sameLocalFileVersion(local, afterOpened) ||
		!sameLocalFileVersion(local, afterLocal) ||
		written != local.Size() {
		return stageResult{}, fail("SFTP_LOCAL_FILE_CHANGED", nil)
	}
	if err := assertNoSymlinkParent(client, value.Root, value.Relative); err != nil {
		return stageResult{}, err
	}

	_, fsyncAvailable := client.HasExtension("fsync@openssh.com")
	if fsyncAvailable {
		if err := writer.Sync(); err != nil {
			return stageResult{}, mapRemoteError(err)
		}
	}
	if err := writer.Close(); err != nil {
		return stageResult{}, mapRemoteError(err)
	}
	staged, err := client.Lstat(target)
	if err != nil {
		return stageResult{}, mapRemoteError(err)
	}
	if staged.Mode()&os.ModeSymlink != 0 || !staged.Mode().IsRegular() || staged.Size() != written {
		return stageResult{}, fail("SFTP_REMOTE_FILE_CHANGED", nil)
	}
	if written == 0 && progress != nil {
		progress(0, 0)
	}
	committed = true
	return stageResult{
		Bytes:  written,
		Sha256: hex.EncodeToString(hash.Sum(nil)),
		Fsync:  fsyncAvailable,
	}, nil
}

func assertNoSymlinkParent(client remoteClient, root, relative string) error {
	segments := strings.Split(relative, "/")
	if relative == "" || len(segments) == 0 {
		return nil
	}
	parentRelative := strings.Join(segments[:len(segments)-1], "/")
	if parentRelative == "" {
		rootInfo, err := client.Lstat(root)
		if err != nil {
			return mapRemoteError(err)
		}
		if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
			return fail("SFTP_REMOTE_ROOT_CHANGED", nil)
		}
		return nil
	}
	return assertNoSymlinkPath(client, root, parentRelative, true)
}

func assertNoSymlinkPath(client remoteClient, root, relative string, wantDirectory bool) error {
	current := root
	rootInfo, err := client.Lstat(current)
	if err != nil {
		return mapRemoteError(err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return fail("SFTP_REMOTE_ROOT_CHANGED", nil)
	}
	segments := strings.Split(relative, "/")
	if relative == "" {
		segments = nil
	}
	for index, segment := range segments {
		current = path.Join(current, segment)
		info, err := client.Lstat(current)
		if err != nil {
			if wantDirectory && errors.Is(err, sftp.ErrSSHFxNoSuchFile) {
				return mapRemoteError(err)
			}
			return mapRemoteError(err)
		}
		last := index == len(segments)-1
		if info.Mode()&os.ModeSymlink != 0 {
			return fail("SFTP_SYMLINK_REJECTED", nil)
		}
		if !last && !info.IsDir() {
			return fail("SFTP_REMOTE_PATH_INVALID", nil)
		}
		if last && wantDirectory && !info.IsDir() {
			return fail("SFTP_NOT_A_DIRECTORY", nil)
		}
	}
	return nil
}

func sameRemoteFileVersion(before, after os.FileInfo) bool {
	return before.Size() == after.Size() && before.ModTime().Equal(after.ModTime()) && before.Mode() == after.Mode()
}

func sameLocalFileVersion(before, after os.FileInfo) bool {
	return before.Size() == after.Size() && before.ModTime().Equal(after.ModTime()) && before.Mode() == after.Mode()
}

func mapRemoteError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, sftp.ErrSSHFxNoSuchFile), errors.Is(err, os.ErrNotExist):
		return fail("SFTP_REMOTE_NOT_FOUND", err)
	case errors.Is(err, sftp.ErrSSHFxPermissionDenied), errors.Is(err, os.ErrPermission):
		return fail("SFTP_PERMISSION_DENIED", err)
	case errors.Is(err, sftp.ErrSSHFxConnectionLost), errors.Is(err, io.ErrUnexpectedEOF):
		return fail("SFTP_REMOTE_CONNECTION_LOST", err)
	case errors.Is(err, sftp.ErrSSHFxOpUnsupported):
		return fail("SFTP_OPERATION_UNSUPPORTED", err)
	default:
		return fail("SFTP_REMOTE_IO_FAILED", err)
	}
}

type progressReader struct {
	reader      io.Reader
	total       int64
	transferred int64
	lastEmit    time.Time
	emit        progressFunc
}

func newProgressReader(reader io.Reader, total int64, emit progressFunc) *progressReader {
	if emit == nil {
		emit = func(int64, int64) {}
	}
	return &progressReader{reader: reader, total: total, emit: emit}
}

func (r *progressReader) Read(buffer []byte) (int, error) {
	n, err := r.reader.Read(buffer)
	if n > 0 {
		r.transferred += int64(n)
		now := time.Now()
		if r.lastEmit.IsZero() || now.Sub(r.lastEmit) >= 100*time.Millisecond || (r.total > 0 && r.transferred == r.total) {
			r.lastEmit = now
			r.emit(r.transferred, r.total)
		}
	}
	return n, err
}

func randomSuffix() (string, error) {
	value := make([]byte, 8)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}
