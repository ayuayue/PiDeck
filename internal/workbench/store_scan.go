//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// sessionFiles lists every session file under root.
func sessionFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files
}

// scanSessions reads the headers and names of the session files in the
// app's store, newest first.
func (s *store) scanSessions(titles map[string]string) []sessionMeta {
	files := sessionFiles(s.sessions)
	metas := s.readMetas(files, titles, nil)
	s.pruneMetas(s.sessions, files)
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	s.saveMetaCache()
	return metas
}

// scanPiSessions reads pi's own session store, keeping the sessions of the
// folders keep allows, at most limit of them. Files of other folders are
// read as far as their header only, so a large store costs what the
// projects on screen hold, not what this machine ever ran.
func (s *store) scanPiSessions(root string, titles map[string]string, keep func(cwd string) bool, limit int) []sessionMeta {
	if root == "" || filepath.Clean(root) == filepath.Clean(s.sessions) {
		return nil
	}
	files := sessionFiles(root)
	metas := s.readMetas(files, titles, keep)
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	if limit > 0 && len(metas) > limit {
		metas = metas[:limit]
	} else {
		s.pruneMetas(root, files)
	}
	for i := range metas {
		metas[i].External = true
	}
	s.saveMetaCache()
	return metas
}

// scanPiSessionRoots reads every store a project may use and merges the
// listings by session id, keeping the newest reading of a copied session.
func (s *store) scanPiSessionRoots(roots []string, titles map[string]string, keep func(cwd string) bool, limit int) []sessionMeta {
	var metas []sessionMeta
	seenRoots := map[string]bool{}
	byID := map[string]int{}
	for _, root := range roots {
		if root == "" {
			continue
		}
		key := pathKey(root)
		if seenRoots[key] {
			continue
		}
		seenRoots[key] = true
		for _, meta := range s.scanPiSessions(root, titles, keep, 0) {
			if meta.ID == "" {
				metas = append(metas, meta)
				continue
			}
			if i, ok := byID[meta.ID]; ok {
				if meta.Updated.After(metas[i].Updated) {
					metas[i] = meta
				}
				continue
			}
			byID[meta.ID] = len(metas)
			metas = append(metas, meta)
		}
	}
	sort.SliceStable(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	if limit > 0 && len(metas) > limit {
		metas = metas[:limit]
	}
	return metas
}

// readMetas builds the listing of each file: cached ones without a read,
// the rest a few at a time, so a cold scan of a large store does not wait
// on one core.
func (s *store) readMetas(files []string, titles map[string]string, want func(cwd string) bool) []sessionMeta {
	results := make([]metaResult, len(files))
	var pending []int
	for i, path := range files {
		if r, done := s.cachedMeta(path, want); done {
			results[i] = r
			continue
		}
		pending = append(pending, i)
	}
	if len(pending) > 0 {
		workers := min(len(pending), min(runtime.GOMAXPROCS(0), 8))
		if workers < 1 {
			workers = 1
		}
		queue := make(chan int)
		var wg sync.WaitGroup
		wg.Add(workers)
		for w := 0; w < workers; w++ {
			go func() {
				defer wg.Done()
				for i := range queue {
					results[i] = s.readMetaFile(files[i], want)
				}
			}()
		}
		for _, i := range pending {
			queue <- i
		}
		close(queue)
		wg.Wait()
	}
	metas := make([]sessionMeta, 0, len(files))
	for _, r := range results {
		if !r.ok || (want != nil && !want(r.meta.Cwd)) {
			continue
		}
		metas = append(metas, applySessionTitle(r.meta, titles))
	}
	return metas
}

// cachedMeta answers a file from the cache when the cache can: an
// unchanged file needs no read, and a listing whose project is off screen
// needs not even a stat.
func (s *store) cachedMeta(path string, want func(cwd string) bool) (metaResult, bool) {
	s.mu.Lock()
	e, found := s.metas[path]
	s.mu.Unlock()
	if !found {
		return metaResult{}, false
	}
	if want != nil && e.OK && !want(e.Meta.Cwd) {
		// Off screen: nothing in this file can change that.
		return metaResult{meta: e.Meta, ok: true}, true
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() != e.Size || !info.ModTime().Equal(e.ModTime) {
		return metaResult{}, false
	}
	if e.Partial && (want == nil || want(e.Meta.Cwd)) {
		// Only the header was read; its project wants the rest now.
		return metaResult{}, false
	}
	return metaResult{meta: e.Meta, ok: e.OK}, true
}

// readMetaFile reads one session file and records its listing.
func (s *store) readMetaFile(path string, want func(cwd string) bool) metaResult {
	info, err := os.Stat(path)
	if err != nil {
		return metaResult{}
	}
	s.mu.Lock()
	prev := s.metas[path]
	s.mu.Unlock()
	read := readSessionMeta(path, prev, want)
	s.mu.Lock()
	if s.metas == nil || len(s.metas) > metaCacheMax {
		s.metas = map[string]metaCacheEntry{}
	}
	s.metas[path] = metaCacheEntry{Size: info.Size(), ModTime: info.ModTime(), Meta: read.meta,
		OK: read.ok, Partial: read.partial, Tail: read.tail}
	s.parses++
	s.consumed += read.tail.Consumed - read.start
	s.metaDirty = true
	s.mu.Unlock()
	if !read.ok {
		return metaResult{}
	}
	return metaResult{meta: read.meta, ok: true}
}

// readMeta returns a session file's listing, reusing the cached one while
// the file is unchanged. Titles come from the config and are applied on
// every call, so a rename does not need a reparse.
func (s *store) readMeta(path string, titles map[string]string) (sessionMeta, bool) {
	r, done := s.cachedMeta(path, nil)
	if !done {
		r = s.readMetaFile(path, nil)
		s.saveMetaCache()
	}
	if !r.ok {
		return sessionMeta{}, false
	}
	return applySessionTitle(r.meta, titles), true
}

// pruneMetas drops the listings of files a scan no longer finds, so a
// deleted session does not stay in the cache for ever.
func (s *store) pruneMetas(root string, files []string) {
	seen := make(map[string]struct{}, len(files))
	for _, path := range files {
		seen[path] = struct{}{}
	}
	prefix := filepath.Clean(root) + string(filepath.Separator)
	s.mu.Lock()
	changed := false
	for path := range s.metas {
		if _, ok := seen[path]; ok || !strings.HasPrefix(path, prefix) {
			continue
		}
		delete(s.metas, path)
		changed = true
	}
	if changed {
		s.metaDirty = true
	}
	s.mu.Unlock()
}

// applySessionTitle puts the user's name, or a placeholder, on a listing.
func applySessionTitle(meta sessionMeta, titles map[string]string) sessionMeta {
	if t := titles[meta.ID]; t != "" {
		meta.Title = t
	} else if meta.Title == "" {
		meta.Title = "未命名会话"
	}
	return meta
}

// countSessions counts the session files without reading them, for the
// settings page, which only needs the number.
func (s *store) countSessions() int {
	n := 0
	_ = filepath.WalkDir(s.sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		n++
		return nil
	})
	return n
}
