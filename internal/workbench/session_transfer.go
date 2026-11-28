//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type piTransferProgress struct {
	Done, Total, Imported, Skipped, Failed int
}

type piTransferResult struct {
	BySource                  map[string]sessionMeta
	Imported, Skipped, Failed int
	Err                       error
}

// scanPiTransferFiles walks ordinary files only. Overlapping roots share a
// path identity, while symlinked files and directories are never followed.
func scanPiTransferFiles(ctx context.Context, roots []string) ([]string, error) {
	var files []string
	seen := make(map[string]bool)
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if root == "" {
			continue
		}
		root, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			if err != nil {
				return err
			}
			if d.IsDir() || d.Type()&os.ModeSymlink != 0 || !strings.EqualFold(filepath.Ext(d.Name()), ".jsonl") {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if key := pathKey(path); info.Mode().IsRegular() && !seen[key] {
				seen[key] = true
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return files, ctx.Err()
}

// transferPiSessions serializes the ID index and publication together, so two
// batches cannot import the same header ID. Only the first failure is retained.
func (s *store) transferPiSessions(ctx context.Context, files []string, cwdMap map[string]string, allow func(string) bool, progress func(piTransferProgress)) piTransferResult {
	result := piTransferResult{BySource: make(map[string]sessionMeta)}
	state := piTransferProgress{Total: len(files)}
	report := func() {
		state.Imported, state.Skipped, state.Failed = result.Imported, result.Skipped, result.Failed
		if progress != nil {
			progress(state)
		}
	}
	report()
	if err := ctx.Err(); err != nil {
		result.Err = err
		return result
	}
	if len(files) == 0 {
		return result
	}
	// A canceled batch must also be able to leave while another import owns
	// the mutex. The waiter releases a late acquisition itself on cancellation.
	locked := make(chan struct{})
	go func() {
		s.importMu.Lock()
		select {
		case locked <- struct{}{}:
		case <-ctx.Done():
			s.importMu.Unlock()
		}
	}()
	select {
	case <-ctx.Done():
		result.Err = ctx.Err()
		return result
	case <-locked:
	}
	defer s.importMu.Unlock()

	root, setupErr := os.OpenRoot(s.sessions)
	var known map[string]sessionMeta
	if setupErr == nil {
		defer root.Close()
		known, setupErr = indexPiTransferSessions(ctx, root)
	}
	for _, src := range files {
		if ctx.Err() != nil {
			break
		}
		var meta sessionMeta
		var imported bool
		err := setupErr
		if err == nil {
			meta, imported, err = s.transferPiSession(ctx, root, src, cwdMap, allow, known)
		}
		switch {
		case err != nil:
			result.Failed++
			if result.Err == nil {
				result.Err = fmt.Errorf("%s: %w", src, err)
			}
		case imported:
			result.Imported++
			result.BySource[src] = meta
		case meta.ID != "":
			result.Skipped++
			result.BySource[src] = meta
		default:
			result.Skipped++
		}
		state.Done++
		report()
	}
	if result.Err == nil {
		result.Err = ctx.Err()
	}
	return result
}

func (s *store) transferPiSession(ctx context.Context, root *os.Root, src string, cwdMap map[string]string, allow func(string) bool, known map[string]sessionMeta) (sessionMeta, bool, error) {
	info, err := os.Lstat(src)
	if err != nil {
		return sessionMeta{}, false, err
	}
	if !info.Mode().IsRegular() {
		return sessionMeta{}, false, fmt.Errorf("source is not a regular file")
	}
	f, err := os.Open(src)
	if err != nil {
		return sessionMeta{}, false, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return sessionMeta{}, false, err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return sessionMeta{}, false, fmt.Errorf("source changed while opening")
	}
	reader := bufio.NewReader(piTransferReader{ctx, f})
	head, pi, err := readPiTransferHeader(reader)
	if err != nil || !pi {
		return sessionMeta{}, false, err
	}
	if allow != nil && !allow(head.Cwd) {
		return sessionMeta{}, false, nil
	}
	if meta, exists := known[head.ID]; exists {
		if full, ok := s.readMeta(meta.File, nil); ok {
			meta = full
		}
		return meta, false, nil
	}
	if cwd, replace := cwdMap[pathKey(head.Cwd)]; replace {
		head.Fields["cwd"], err = json.Marshal(cwd)
		if err != nil {
			return sessionMeta{}, false, err
		}
		raw, err := json.Marshal(head.Fields)
		if err != nil {
			return sessionMeta{}, false, err
		}
		if bytes.HasSuffix(head.Raw, []byte("\r\n")) {
			raw = append(raw, '\r', '\n')
		} else if bytes.HasSuffix(head.Raw, []byte("\n")) {
			raw = append(raw, '\n')
		}
		head.Raw, head.Cwd = raw, cwd
	}
	dst, err := copyPiTransferSession(ctx, root, head, reader, opened)
	if err != nil {
		return sessionMeta{}, false, err
	}
	meta := head.meta(dst, opened)
	if full, ok := s.readMeta(dst, nil); ok {
		meta = full
	}
	known[head.ID] = meta
	return meta, true, nil
}

const piTransferHeaderLimit = 1 << 20

type piTransferHeader struct {
	ID, Cwd, Timestamp, Parent string
	Raw                        []byte
	Fields                     map[string]json.RawMessage
}

func readPiTransferHeader(r *bufio.Reader) (piTransferHeader, bool, error) {
	var raw []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(raw)+len(part) > piTransferHeaderLimit {
			return piTransferHeader{}, false, fmt.Errorf("pi session header exceeds %d bytes", piTransferHeaderLimit)
		}
		raw = append(raw, part...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return piTransferHeader{}, false, err
		}
		break
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return piTransferHeader{}, false, nil
	}
	head := piTransferHeader{Raw: raw}
	if err := json.Unmarshal(raw, &head.Fields); err != nil {
		if json.Valid(raw) {
			return piTransferHeader{}, false, nil
		}
		return piTransferHeader{}, false, fmt.Errorf("不是有效的 pi 会话文件: %w", err)
	}
	var kind string
	if json.Unmarshal(head.Fields["type"], &kind) != nil || kind != "session" {
		return piTransferHeader{}, false, nil
	}
	if json.Unmarshal(head.Fields["id"], &head.ID) != nil || !validPiSessionID(head.ID) {
		return piTransferHeader{}, false, fmt.Errorf("不是有效的 pi 会话文件")
	}
	if cwd, exists := head.Fields["cwd"]; exists && json.Unmarshal(cwd, &head.Cwd) != nil {
		return piTransferHeader{}, false, fmt.Errorf("不是有效的 pi 会话文件")
	}
	_ = json.Unmarshal(head.Fields["timestamp"], &head.Timestamp)
	_ = json.Unmarshal(head.Fields["parentSession"], &head.Parent)
	return head, true, nil
}

func (h piTransferHeader) meta(path string, info fs.FileInfo) sessionMeta {
	created, _ := time.Parse(time.RFC3339Nano, h.Timestamp)
	return applySessionTitle(sessionMeta{ID: h.ID, Cwd: filepath.Clean(h.Cwd), File: path,
		Created: created, Updated: info.ModTime(), Parent: strings.TrimSpace(h.Parent)}, nil)
}

// Existing files are indexed by their header, not by an assumed filename.
// Invalid old files do not reserve an ID and are never replaced.
func indexPiTransferSessions(ctx context.Context, root *os.Root) (map[string]sessionMeta, error) {
	known := make(map[string]sessionMeta)
	err := fs.WalkDir(root.FS(), ".", func(path string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 || !strings.EqualFold(filepath.Ext(d.Name()), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() {
			return err
		}
		f, err := root.Open(path)
		if err != nil {
			return err
		}
		opened, statErr := f.Stat()
		if statErr != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
			f.Close()
			if statErr != nil {
				return statErr
			}
			return fmt.Errorf("session changed while indexing")
		}
		head, pi, readErr := readPiTransferHeader(bufio.NewReader(piTransferReader{ctx, f}))
		closeErr := f.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if closeErr != nil {
			return closeErr
		}
		if readErr == nil && pi {
			if _, exists := known[head.ID]; !exists {
				known[head.ID] = head.meta(filepath.Join(root.Name(), filepath.FromSlash(path)), opened)
			}
		}
		return nil
	})
	return known, err
}
