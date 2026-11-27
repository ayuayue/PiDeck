//go:build !js && !android && !ios

package workbench

import (
	"cmp"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type fileSort string

const (
	fileSortName     fileSort = "name"
	fileSortNameDesc fileSort = "name-desc"
	fileSortModified fileSort = "modified"
	fileSortOldest   fileSort = "oldest"
	fileSortType     fileSort = "type"
	fileSortTypeDesc fileSort = "type-desc"
	fileSortSize     fileSort = "size"
	fileSortSmallest fileSort = "smallest"
)

// compareFileEntries leaves directories first in either direction. Missing
// metadata and the bounded directory-list marker follow real entries.
func compareFileEntries(a, b fileEntry, order fileSort) int {
	if (a.Name == "…") != (b.Name == "…") {
		if a.Name == "…" {
			return 1
		}
		return -1
	}
	if a.Dir != b.Dir {
		if a.Dir {
			return -1
		}
		return 1
	}
	var comparison int
	switch order {
	case fileSortModified, fileSortOldest, fileSortSize, fileSortSmallest:
		if a.Known != b.Known {
			if a.Known {
				return -1
			}
			return 1
		}
		if order == fileSortModified || order == fileSortOldest {
			comparison = a.Modified.Compare(b.Modified)
		} else if !a.Dir {
			comparison = cmp.Compare(a.Size, b.Size)
		}
		if order == fileSortModified || order == fileSortSize {
			comparison = -comparison
		}
	case fileSortType, fileSortTypeDesc:
		if !a.Dir {
			comparison = strings.Compare(fileExtension(a.Name), fileExtension(b.Name))
			if order == fileSortTypeDesc {
				comparison = -comparison
			}
		}
	}
	if comparison != 0 {
		return comparison
	}
	comparison = strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	if comparison == 0 {
		comparison = strings.Compare(a.Path, b.Path)
	}
	if order == fileSortNameDesc || order == fileSortTypeDesc {
		comparison = -comparison
	}
	return comparison
}

func fileExtension(name string) string {
	if strings.HasPrefix(name, ".") && strings.Count(name, ".") == 1 {
		return ""
	}
	return strings.ToLower(filepath.Ext(name))
}

func sortedFileEntries(entries []fileEntry, order fileSort) []fileEntry {
	out := slices.Clone(entries)
	slices.SortStableFunc(out, func(a, b fileEntry) int { return compareFileEntries(a, b, order) })
	return out
}

func (t *fileTree) setOrder(order fileSort) {
	if t.order.GetUntracked() == order {
		return
	}
	t.order.Set(order)
	t.rebuild()
}

// readFileSortEntries runs in the existing background index scan, never while
// constructing rows. Unreadable or deleted files remain sortable by name.
func readFileSortEntries(root string, paths []string) map[string]fileEntry {
	entries := make(map[string]fileEntry, len(paths))
	for _, rel := range paths {
		entry := fileEntry{Name: filepath.Base(rel), Path: rel}
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil {
			entry.Modified, entry.Size, entry.Known = info.ModTime(), info.Size(), true
		}
		entries[rel] = entry
	}
	return entries
}

// sortedWorkspacePaths sorts a copy, preserving the shared completion index.
func (a *app) sortedWorkspacePaths(root string, paths []string) []string {
	order := a.files.order.Get()
	_ = a.filesRev.Get()
	if order == fileSortModified || order == fileSortOldest || order == fileSortSize || order == fileSortSmallest {
		a.workspaceFiles(root)
	}
	a.fileIdx.mu.Lock()
	entries := make([]fileEntry, 0, len(paths))
	for _, rel := range paths {
		entry := a.fileIdx.entries[rel]
		if a.fileIdx.root != root || entry.Name == "" {
			entry = fileEntry{Name: filepath.Base(rel), Path: rel}
		}
		entries = append(entries, entry)
	}
	a.fileIdx.mu.Unlock()
	entries = sortedFileEntries(entries, order)
	out := make([]string, len(entries))
	for i, entry := range entries {
		out[i] = entry.Path
	}
	return out
}

func (a *app) refreshFileBrowser() {
	a.fileIdx.mu.Lock()
	a.fileIdx.at = time.Time{}
	a.fileIdx.mu.Unlock()
	a.files.reload()
	a.filesRev.Update(func(n int) int { return n + 1 })
}
