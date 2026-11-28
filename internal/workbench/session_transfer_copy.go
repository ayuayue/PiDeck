//go:build !js && !android && !ios

package workbench

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type piTransferReader struct {
	ctx context.Context
	r   io.Reader
}

func (r piTransferReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.r.Read(p)
	if ctxErr := r.ctx.Err(); ctxErr != nil {
		return n, ctxErr
	}
	return n, err
}

// copyPiTransferSession streams the body unchanged. All target operations are
// rooted, including temporary creation and rename, to prevent symlink escapes.
func copyPiTransferSession(ctx context.Context, root *os.Root, head piTransferHeader, body io.Reader, info os.FileInfo) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !validPiSessionID(head.ID) {
		return "", fmt.Errorf("不是有效的 pi 会话文件")
	}
	folder := encodeCwd(filepath.Clean(head.Cwd))
	if !filepath.IsLocal(folder) || filepath.Base(folder) != folder {
		return "", fmt.Errorf("unsafe session directory")
	}
	if err := root.Mkdir(folder, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	dir, err := root.OpenRoot(folder)
	if err != nil {
		return "", err
	}
	defer dir.Close()
	tmpName := ".pideck-" + rand.Text() + ".tmp"
	tmp, err := dir.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}
	defer dir.Remove(tmpName)
	defer tmp.Close()
	if _, err := tmp.Write(head.Raw); err != nil {
		return "", err
	}
	if _, err := io.Copy(tmp, piTransferReader{ctx, body}); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := dir.Chtimes(tmpName, info.ModTime(), info.ModTime()); err != nil {
		return "", err
	}
	stamp, err := time.Parse(time.RFC3339Nano, head.Timestamp)
	if err != nil {
		stamp = info.ModTime()
	}
	// The random component also avoids collisions with unrelated or malformed
	// existing files; the stable _<id>.jsonl suffix retains pi's convention.
	name := stamp.UTC().Format("2006-01-02T15-04-05-000Z") + "-" + rand.Text() + "_" + head.ID + ".jsonl"
	if _, err := dir.Lstat(name); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			err = os.ErrExist
		}
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := dir.Rename(tmpName, name); err != nil {
		return "", err
	}
	return filepath.Join(root.Name(), folder, name), nil
}
