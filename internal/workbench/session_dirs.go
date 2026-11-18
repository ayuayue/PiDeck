//go:build !js && !android && !ios

package workbench

// pi can keep a project's sessions outside its default global store. This
// file resolves every store a project may use: the default one is always
// scanned, and a configured sessionDir is added when it exists.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// localProjectPaths lists the local project folders whose pi settings may
// add another session store.
func (a *app) localProjectPaths() []string {
	seen := map[string]bool{}
	var paths []string
	for _, ws := range a.workspaces.GetUntracked() {
		if ws == nil || ws.Target.remote() || ws.Path == "" {
			continue
		}
		key := pathKey(ws.Path)
		if seen[key] {
			continue
		}
		seen[key] = true
		paths = append(paths, ws.Path)
	}
	return paths
}

// piSessionRoots resolves the stores that may hold a project's sessions.
// The default store stays first, so moving a project to a local sessionDir
// does not hide the history it had before.
func piSessionRoots(projects []string) []string {
	roots := uniqueSessionRoots(piSessionsDir())
	globalSetting := readSessionDirSetting(piSettingsPath())
	seenProjects := map[string]bool{}
	for _, project := range projects {
		if project == "" {
			continue
		}
		key := pathKey(project)
		if seenProjects[key] {
			continue
		}
		seenProjects[key] = true
		raw := readSessionDirSetting(filepath.Join(project, ".pi", "settings.json"))
		if raw == "" {
			raw = globalSetting
		}
		if dir := resolvePiSessionDir(raw, project); dir != "" && dirExists(dir) {
			roots = append(roots, dir)
		}
	}
	// Usage and search can run before a project exists. An absolute or ~
	// based global setting is still useful then; a relative one has no
	// project folder to resolve against.
	if len(seenProjects) == 0 {
		if dir := resolvePiSessionDir(globalSetting, ""); dir != "" && dirExists(dir) {
			roots = append(roots, dir)
		}
	}
	return uniqueSessionRoots(roots...)
}

// readSessionDirSetting reads pi's sessionDir from a settings file. A
// missing or malformed file contributes nothing.
func readSessionDirSetting(path string) string {
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var settings struct {
		SessionDir string `json:"sessionDir"`
	}
	if json.Unmarshal(raw, &settings) != nil {
		return ""
	}
	return strings.TrimSpace(settings.SessionDir)
}

// resolvePiSessionDir follows pi: expand a leading ~, and resolve a relative
// sessionDir against the project cwd rather than the settings file.
func resolvePiSessionDir(raw, project string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	value = expandPiHome(value)
	if !filepath.IsAbs(value) {
		if project == "" {
			return ""
		}
		value = filepath.Join(project, value)
	}
	return filepath.Clean(value)
}

// expandPiHome expands ~ and ~/... to this machine's home folder.
func expandPiHome(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, `~\`) {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	return filepath.Join(home, path[2:])
}

// uniqueSessionRoots cleans and deduplicates a list of stores.
func uniqueSessionRoots(roots ...string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(roots))
	for _, root := range roots {
		if root == "" {
			continue
		}
		root = filepath.Clean(root)
		key := pathKey(root)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, root)
	}
	return out
}

// dirExists reports whether a configured sessionDir can be scanned.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
