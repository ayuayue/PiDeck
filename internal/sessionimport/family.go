//go:build !js && !android && !ios

package sessionimport

// The two families that keep one folder per project, named after the
// project's path: Cursor's agent transcripts and the CodeBuddy/WorkBuddy
// pair. The folder name is lossy (a folder called a-b and one called a/b
// read alike), so a session's own record wins when it names a folder.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// familySlug is a project path as these tools name its folder:
// `F:\PiDeck` is `f-PiDeck`, `/home/u/repo` is `home-u-repo`.
func familySlug(path string) string {
	p := strings.ReplaceAll(path, "\\", "/")
	p = strings.TrimRight(p, "/")
	if len(p) >= 2 && p[1] == ':' && isDriveLetter(rune(p[0])) {
		return strings.ToLower(p[:1]) + "-" + strings.ReplaceAll(p[3:], "/", "-")
	}
	return strings.ReplaceAll(strings.TrimLeft(p, "/"), "/", "-")
}

// familySlugPath decodes a folder name back into a path, as far as it can:
// the dashes are not knowable, so the caller checks the folder exists.
func familySlugPath(slug string) string {
	if len(slug) >= 3 && slug[1] == '-' && slug[0] != '-' && isDriveLetter(rune(slug[0])) {
		return strings.ToUpper(slug[:1]) + ":\\" + strings.ReplaceAll(slug[2:], "-", "\\")
	}
	return "/" + strings.ReplaceAll(slug, "-", "/")
}

// isDriveLetter reports whether r is a Windows drive letter.
func isDriveLetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}

// familySlugOf finds the folder a session file lives in, by name, under a
// projects folder.
func familySlugOf(path, projects string) string {
	rel, err := filepath.Rel(projects, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

// familyFiles lists a projects folder's transcripts, skipping subagent
// transcripts and the undo logs beside them.
func familyFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "subagents" {
				return filepath.SkipDir
			}
			return nil
		}
		lower := strings.ToLower(d.Name())
		if !strings.HasSuffix(lower, ".jsonl") || strings.HasSuffix(lower, ".file-rollback.ndjson") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	sort.Strings(files)
	return files
}
