//go:build !js && !android && !ios

package workbench

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
)

const (
	pluginArchiveDir   = "trash/plugins"
	localManifestLimit = 10 << 20
)

// An archive slot contains the original file or directory under its original
// name. Restoring needs no separate metadata file that could get out of sync.
type archivedPlugin struct {
	slot, name, revision string
	label, version       string
	problem              string
	archivedAt           time.Time
}

type pluginArchiveSnapshot struct {
	items []archivedPlugin
	err   error
}

func pluginEntryName(name string) bool {
	return name != "." && filepath.IsLocal(name) && !strings.ContainsAny(name, "/\\:\x00")
}

// pluginInstallPath validates the two layouts the loader understands. A
// folder is always moved as a unit, including its local theme files.
func pluginInstallPath(dir, manifest string) string {
	if dir == "" || manifest == "" {
		return ""
	}
	rel, err := filepath.Rel(dir, manifest)
	if err != nil {
		return ""
	}
	name, leaf, folder := strings.Cut(rel, string(filepath.Separator))
	if !pluginEntryName(name) || (folder && leaf != "plugin.json") || (!folder && !isJSONFile(name)) {
		return ""
	}
	return filepath.Join(dir, name)
}

func pluginArchiveChanged() error {
	return errors.New(apptext.T("插件文件已变化，请重新加载后重试"))
}

// pluginManifestAt accepts regular files only. The caller checks that the
// parent directory is a real directory, and Root confines every lookup.
func pluginManifestAt(root *os.Root, entry string) ([]byte, string, error) {
	info, err := root.Lstat(entry)
	if err != nil {
		return nil, entry, err
	}
	manifest := entry
	if info.IsDir() {
		manifest = filepath.Join(entry, "plugin.json")
		info, err = root.Lstat(manifest)
		if err != nil {
			return nil, manifest, err
		}
	} else if !isJSONFile(entry) {
		return nil, manifest, pluginArchiveChanged()
	}
	if !info.Mode().IsRegular() || info.Size() > localManifestLimit {
		return nil, manifest, errors.New(apptext.T("插件清单必须是 10 MB 以内的普通文件"))
	}
	f, err := root.Open(manifest)
	if err != nil {
		return nil, manifest, err
	}
	defer f.Close()
	current, err := f.Stat()
	if err != nil || !os.SameFile(info, current) {
		return nil, manifest, pluginArchiveChanged()
	}
	raw, err := io.ReadAll(io.LimitReader(f, localManifestLimit+1))
	if err == nil && len(raw) > localManifestLimit {
		err = errors.New(apptext.T("插件清单必须是 10 MB 以内的普通文件"))
	}
	return raw, manifest, err
}

func requirePluginDir(root *os.Root, dir string, create bool) error {
	info, err := root.Lstat(dir)
	if create && errors.Is(err, fs.ErrNotExist) {
		if err = root.Mkdir(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		info, err = root.Lstat(dir)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return pluginArchiveChanged()
	}
	return nil
}

func openPluginArchive(root *os.Root, create bool) (*os.Root, error) {
	for _, dir := range []string{"trash", pluginArchiveDir} {
		if err := requirePluginDir(root, dir, create); err != nil {
			return nil, err
		}
	}
	return root.OpenRoot(pluginArchiveDir)
}

func (a *app) archivePlugin(p plugin) error {
	entry := pluginInstallPath(a.pluginsDir(), p.Path)
	if p.manifestRevision == "" || entry == "" {
		return pluginArchiveChanged()
	}
	root, err := os.OpenRoot(a.st.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := requirePluginDir(root, "plugins", false); err != nil {
		return err
	}
	name := filepath.Base(entry)
	src := filepath.Join("plugins", name)
	raw, manifest, err := pluginManifestAt(root, src)
	if err != nil || filepath.Clean(filepath.Join(a.st.dir, manifest)) != filepath.Clean(p.Path) || workspaceRevision(raw) != p.manifestRevision {
		return pluginArchiveChanged()
	}
	archive, err := openPluginArchive(root, true)
	if err != nil {
		return err
	}
	defer archive.Close()
	slot := rand.Text()
	if err := archive.Mkdir(slot, 0o755); err != nil {
		return err
	}
	if err := root.Rename(src, filepath.Join(pluginArchiveDir, slot, name)); err != nil {
		return errors.Join(err, archive.Remove(slot))
	}
	return nil
}

func canArchivePlugin(p plugin) bool {
	return p.manifestRevision != ""
}

func (a *app) archivedPlugins() ([]archivedPlugin, error) {
	root, err := os.OpenRoot(a.st.dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	archive, err := openPluginArchive(root, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	return listArchivedPlugins(archive)
}

func listArchivedPlugins(archive *os.Root) ([]archivedPlugin, error) {
	slots, err := fs.ReadDir(archive.FS(), ".")
	if err != nil {
		return nil, err
	}
	var list []archivedPlugin
	for _, slot := range slots {
		if !slot.IsDir() || !pluginEntryName(slot.Name()) {
			continue
		}
		entries, err := fs.ReadDir(archive.FS(), slot.Name())
		if err != nil || len(entries) != 1 || !pluginEntryName(entries[0].Name()) {
			continue
		}
		name := entries[0].Name()
		raw, _, err := pluginManifestAt(archive, filepath.Join(slot.Name(), name))
		if err != nil {
			continue
		}
		p, err := decodeLocalPlugin(raw, name)
		problem := ""
		if err != nil {
			problem = err.Error()
			p.Name = fileBase(name)
		} else if !normalizePluginIdentity(&p) {
			problem = p.Error
		}
		info, err := slot.Info()
		if err == nil {
			list = append(list, archivedPlugin{slot: slot.Name(), name: name, revision: workspaceRevision(raw),
				label: p.Name, version: p.Version, problem: problem, archivedAt: info.ModTime()})
		}
	}
	slices.SortStableFunc(list, func(a, b archivedPlugin) int { return b.archivedAt.Compare(a.archivedAt) })
	return list, nil
}

func (a *app) restoreArchivedPlugin(item archivedPlugin) error {
	if a.st == nil || !pluginEntryName(item.slot) || !pluginEntryName(item.name) || item.revision == "" {
		return pluginArchiveChanged()
	}
	root, err := os.OpenRoot(a.st.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	archive, err := openPluginArchive(root, false)
	if err != nil {
		return err
	}
	defer archive.Close()
	if err := requirePluginDir(archive, item.slot, false); err != nil {
		return err
	}
	src := filepath.Join(item.slot, item.name)
	raw, _, err := pluginManifestAt(archive, src)
	if err != nil || workspaceRevision(raw) != item.revision {
		return pluginArchiveChanged()
	}
	p, decodeErr := decodeLocalPlugin(raw, item.name)
	if err := requirePluginDir(root, "plugins", true); err != nil {
		return err
	}
	target := filepath.Join("plugins", item.name)
	if _, err := root.Lstat(target); err == nil {
		return errors.New(apptext.T("原插件路径已被占用"))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if decodeErr == nil && p.ID != "" {
		if err := checkPluginRestoreID(root, p.ID); err != nil {
			return err
		}
	}
	if err := root.Rename(filepath.Join(pluginArchiveDir, src), target); err != nil {
		return err
	}
	// An empty slot has no entry and is ignored even if cleanup fails.
	_ = archive.Remove(item.slot)
	return nil
}

func archivedPluginTestID(item archivedPlugin) string {
	sum := sha256.Sum256([]byte(item.slot + "\x00" + item.name))
	return "plugin-restore-" + hex.EncodeToString(sum[:8])
}

func checkPluginRestoreID(root *os.Root, id string) error {
	entries, err := fs.ReadDir(root.FS(), "plugins")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && !isJSONFile(entry.Name()) {
			continue
		}
		raw, _, err := pluginManifestAt(root, filepath.Join("plugins", entry.Name()))
		if err != nil {
			continue
		}
		if p, err := decodeLocalPlugin(raw, entry.Name()); err == nil && p.ID == id {
			return errors.New(apptext.T("存在重复的插件 id：%s", id))
		}
	}
	return nil
}
