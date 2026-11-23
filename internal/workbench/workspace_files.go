//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
)

var (
	errFilePath     = errors.New("路径不在这个项目里")
	errFileConflict = errors.New("文件有外部修改，请重新读取后再保存。")
	errFileTooLarge = errors.New("文件超过编辑大小限制")
	errFileBinary   = errors.New("这是二进制文件，不能当文本读")
)

type workspaceFile struct {
	target target
	root   string
	rel    string
}

func fileEditorError(err error) string {
	switch {
	case errors.Is(err, errFileConflict):
		return apptext.T("文件有外部修改，请重新读取后再保存。")
	case errors.Is(err, errFilePath):
		return apptext.T("路径不在这个项目里")
	case errors.Is(err, errFileTooLarge):
		return apptext.T("文件超过编辑大小限制")
	case errors.Is(err, errFileBinary):
		return apptext.T("这是二进制文件，不能当文本读")
	default:
		return err.Error()
	}
}

func workspaceFileRel(raw string) (string, bool) {
	// Wire paths use slashes. Backslashes on Windows have the same path
	// meaning; on other targets they are disallowed to keep one wire form.
	if raw == "" || strings.ContainsAny(raw, "\x00\r\n\\:") || !fs.ValidPath(raw) || raw == "." {
		return "", false
	}
	for part := range strings.SplitSeq(raw, "/") {
		switch strings.ToLower(strings.TrimRight(part, ". ")) {
		case ".git", ".hg", ".svn", "":
			return "", false
		}
	}
	return raw, true
}

func workspaceRevision(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func isFileRevision(value string) bool {
	_, err := hex.DecodeString(value)
	return len(value) == sha256.Size*2 && err == nil
}

func readTextFile(r io.Reader, maxBytes int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errFileTooLarge
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) != -1 {
		return nil, errFileBinary
	}
	return data, nil
}

func (f workspaceFile) read(ctx context.Context, limit int64) ([]byte, error) {
	if _, ok := workspaceFileRel(f.rel); !ok {
		return nil, errFilePath
	}
	if f.target.remote() {
		return f.readTarget(ctx, limit)
	}
	root, err := os.OpenRoot(f.root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	data, _, err := readWorkspaceFile(root, f.rel, limit)
	return data, err
}

func readWorkspaceFile(root *os.Root, rel string, limit int64) ([]byte, os.FileMode, error) {
	name := filepath.FromSlash(rel)
	for parent := filepath.Dir(name); parent != "."; parent = filepath.Dir(parent) {
		st, err := root.Lstat(parent)
		if err != nil {
			return nil, 0, err
		}
		if !st.IsDir() {
			return nil, 0, errFilePath
		}
	}
	info, err := root.Lstat(name)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, errFilePath
	}
	if info.Size() > limit {
		return nil, 0, errFileTooLarge
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	data, err := readTextFile(file, limit)
	return data, info.Mode().Perm(), err
}

// Stripes keep all in-app writers, including HTTP requests, from passing
// the same revision check at the same time.
var workspaceFileLocks [64]sync.Mutex

func (f workspaceFile) save(ctx context.Context, expected string, data []byte, limit int64) (string, error) {
	if _, ok := workspaceFileRel(f.rel); !ok {
		return "", errFilePath
	}
	if !isFileRevision(expected) {
		return "", errFileConflict
	}
	if _, err := readTextFile(bytes.NewReader(data), limit); err != nil {
		return "", err
	}
	key := strings.ToLower(f.target.key() + "|" + f.root + "|" + f.rel)
	lock := &workspaceFileLocks[sha256.Sum256([]byte(key))[0]%byte(len(workspaceFileLocks))]
	lock.Lock()
	defer lock.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	var err error
	if f.target.remote() {
		err = f.saveTarget(ctx, expected, data)
	} else {
		err = f.saveLocal(expected, data, limit)
	}
	if err != nil {
		return "", err
	}
	return workspaceRevision(data), nil
}

func (f workspaceFile) saveLocal(expected string, data []byte, limit int64) error {
	root, err := os.OpenRoot(f.root)
	if err != nil {
		return err
	}
	defer root.Close()
	current, mode, err := readWorkspaceFile(root, f.rel, limit)
	if err != nil {
		return err
	}
	if workspaceRevision(current) != expected {
		return errFileConflict
	}
	dest := filepath.FromSlash(f.rel)
	tmp := filepath.Join(filepath.Dir(dest), fmt.Sprintf(".pideck-save-%s.tmp", newSessionID()))
	file, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, writeErr := file.Write(data)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	// Check again after staging, since a Git checkout or another editor
	// may have changed the bytes while the new version was written.
	current, _, err = readWorkspaceFile(root, f.rel, limit)
	if err != nil {
		return err
	}
	if workspaceRevision(current) != expected {
		return errFileConflict
	}
	return root.Rename(tmp, dest)
}
