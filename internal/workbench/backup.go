//go:build !js && !android && !ios

package workbench

// A settings backup: config and the add-on folders in one zip. Sessions,
// logs and exports stay out. The archive may contain credentials.

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// backupItems are the data folder's entries a settings backup carries.
var backupItems = []string{"config.json", sessionOrganizationFile, balanceAccountsFile, promptTemplateFile, replyShortcutsFile, "plugins", pluginArchiveDir, "themes", "prompts", "agents", "acp", "sounds"}

const (
	backupFileLimit  = 10 << 20
	backupTotalLimit = 50 << 20
)

// exportSettings writes a settings zip under exports/ without blocking the UI.
func (a *app) exportSettings(done func()) {
	if a.st == nil {
		done()
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	go func() {
		path := filepath.Join(dir, "settings-"+time.Now().Format("20060102-150405")+".zip")
		err := os.MkdirAll(dir, 0o755)
		if err == nil {
			err = a.writeSettingsZip(path)
		}
		a.cx.Post(func() {
			done()
			if err != nil {
				a.toast(ui.ToastError, "导出设置失败", err.Error())
				return
			}
			a.diagf("info", "已导出设置包到 %s", path)
			a.toastAction(ui.ToastSuccess, "已导出设置包", path, "打开", func() {
				a.revealFilePath(localTarget, path)
			})
		})
	}()
}

// A first-time user can open exports before creating any exported files.
func (a *app) openDataExports(done func()) {
	if a.st == nil {
		done()
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	go func() {
		err := os.MkdirAll(dir, 0o755)
		a.cx.Post(func() {
			done()
			if err != nil {
				a.toast(ui.ToastError, "打不开文件夹", err.Error())
				return
			}
			a.openFolder(localTarget, dir)
		})
	}()
}

// writeSettingsZip builds the backup at path.
func (a *app) writeSettingsZip(path string) error {
	data, err := a.settingsZip()
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, 0o600)
}

func (a *app) settingsZip() ([]byte, error) {
	if a.st == nil {
		return nil, errors.New("找不到数据目录")
	}
	var buf bytes.Buffer
	root, err := os.OpenRoot(a.st.dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	zw := zip.NewWriter(&buf)
	var total int64
	add := func(rel string) error {
		info, err := root.Lstat(rel)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if info.Size() > backupFileLimit {
			return fmt.Errorf("%s 超过 10 MB", rel)
		}
		total += info.Size()
		if total > backupTotalLimit {
			return errors.New("设置包超过 50 MB")
		}
		w, err := zw.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		f, err := root.Open(rel)
		if err != nil {
			return err
		}
		defer f.Close()
		n, err := io.Copy(w, io.LimitReader(f, info.Size()+1))
		if err == nil && n != info.Size() {
			return fmt.Errorf("%s changed during backup", rel)
		}
		return err
	}
	for _, item := range backupItems {
		info, err := root.Lstat(item)
		if err != nil {
			continue
		}
		if !info.IsDir() {
			if err := add(item); err != nil {
				_ = zw.Close()
				return nil, err
			}
			continue
		}
		err = fs.WalkDir(root.FS(), item, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			return add(filepath.FromSlash(p))
		})
		if err != nil {
			_ = zw.Close()
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// backupPathAllowed says whether a zip entry belongs in a settings backup.
func backupPathAllowed(name string) bool {
	name = filepath.ToSlash(strings.TrimPrefix(name, "./"))
	if name == "config.json" || name == sessionOrganizationFile {
		return true
	}
	for _, item := range backupItems {
		if item != "config.json" && item != sessionOrganizationFile &&
			(name == item || strings.HasPrefix(name, item+"/")) {
			return true
		}
	}
	return false
}

// settingsZipNames validates a settings zip and lists the files it would
// write. Unknown entries are ignored; unsafe ones refuse the whole zip.
func (a *app) settingsZipNames(path string) ([]string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("不是有效的 zip：%w", err)
	}
	defer zr.Close()
	return settingsArchiveNames(&zr.Reader)
}

func settingsArchiveNames(zr *zip.Reader) ([]string, error) {
	var names []string
	seen := map[string]bool{}
	var total int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := strings.TrimPrefix(f.Name, "./")
		if !fs.ValidPath(name) || !filepath.IsLocal(filepath.FromSlash(name)) || strings.ContainsAny(name, "\\:\x00") {
			return nil, errors.New("设置包里有不安全的路径：" + f.Name)
		}
		if !f.Mode().IsRegular() {
			return nil, errors.New("设置包里有不支持的文件类型：" + f.Name)
		}
		if !backupPathAllowed(name) {
			continue
		}
		key := strings.ToLower(filepath.Clean(name))
		if seen[key] {
			return nil, fmt.Errorf("设置包里有重复的文件：%s", name)
		}
		seen[key] = true
		if f.UncompressedSize64 > backupFileLimit {
			return nil, fmt.Errorf("%s 超过 10 MB", f.Name)
		}
		total += int64(f.UncompressedSize64)
		if total > backupTotalLimit {
			return nil, errors.New("设置包超过 50 MB")
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, errors.New("设置包里没有可恢复的文件")
	}
	return names, nil
}

// importSettings asks, then restores a settings zip.
func (a *app) importSettings(path string) {
	if a.st == nil || path == "" {
		return
	}
	names, err := a.settingsZipNames(path)
	if err != nil {
		a.toast(ui.ToastError, "读取设置包失败", err.Error())
		return
	}
	a.askConfirm("导入设置包",
		fmt.Sprintf("将把 %d 个文件写进数据目录，同名文件会被覆盖。部分设置重启后生效。", len(names)),
		"导入", func() {
			go func() {
				err := a.applySettingsZip(path)
				a.cx.Post(func() {
					if err != nil {
						a.toast(ui.ToastError, "导入设置失败", err.Error())
						return
					}
					a.reloadSettingsAfterImport()
				})
			}()
		})
}

func (a *app) reloadSettingsAfterImport() {
	a.cfg = a.st.config()
	a.pinned.Set(a.cfg.Pinned)
	a.favModels.Set(a.cfg.FavModels)
	org := readSessionOrganization(a.st.dir)
	a.st.organizationMu.Lock()
	a.st.organization = org
	a.st.organizationMu.Unlock()
	a.organization.Set(org)
	a.reduceEffects.Set(a.cfg.ReduceEffects)
	a.codeWrap.Set(a.cfg.CodeWrap)
	a.bgImage.Set(a.cfg.wallpaper())
	a.bgOpacity.Set(a.backgroundOpacity())
	a.applyBrand()
	a.chatWidthPctSig.Set(a.cfg.ChatWidthPct)
	a.tabWidthPctSig.Set(a.cfg.TabWidthPct)
	a.alertVolumeSig.Set(a.configuredAlertVolumePct())
	a.git.view.Set(a.gitChangesView())
	a.applyLanguage()
	a.applyFonts()
	a.prompts.Set(a.loadPrompts())
	a.reloadAddons()
	a.toast(ui.ToastSuccess, "已导入设置包", "插件、主题与提示词已重新读取。")
}

// applySettingsZip restores files and reloads config under the config writer lock.
func (a *app) applySettingsZip(path string) error {
	if a.st == nil {
		return errors.New("找不到数据目录")
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	// Keep queued saves from writing a pre-import snapshot over the restored file.
	a.st.writeMu.Lock()
	defer a.st.writeMu.Unlock()
	if err := a.applySettingsArchive(&zr.Reader); err != nil {
		return err
	}
	if containsRestoredConfig(&zr.Reader) {
		return a.st.reload()
	}
	return nil
}

func (a *app) applySettingsArchive(zr *zip.Reader) error {
	if _, err := settingsArchiveNames(zr); err != nil {
		return err
	}
	root, err := os.OpenRoot(a.st.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	type entry struct {
		path string
		data []byte
	}
	var entries []entry
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := strings.TrimPrefix(f.Name, "./")
		if !backupPathAllowed(name) {
			continue
		}
		dest := filepath.FromSlash(name)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(rc, backupFileLimit+1))
		rc.Close()
		if err != nil {
			return err
		}
		if len(data) > backupFileLimit {
			return fmt.Errorf("%s 超过 10 MB", name)
		}
		if filepath.Clean(dest) == "config.json" {
			var cfg config
			if err := json.Unmarshal(data, &cfg); err != nil {
				return err
			}
		}
		entries = append(entries, entry{path: dest, data: data})
	}
	for _, f := range entries {
		if err := root.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
			return err
		}
		if err := restoreSettingsEntry(root, f.path, f.data); err != nil {
			return err
		}
	}
	return nil
}

func containsRestoredConfig(zr *zip.Reader) bool {
	for _, f := range zr.File {
		if !f.FileInfo().IsDir() && filepath.Clean(f.Name) == "config.json" {
			return true
		}
	}
	return false
}

func restoreSettingsEntry(root *os.Root, path string, data []byte) error {
	tmp := path + "." + newSessionID() + ".tmp"
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, writeErr := f.Write(data)
	if err := errors.Join(writeErr, f.Close()); err != nil {
		return err
	}
	return root.Rename(tmp, path)
}

// pickSettingsZip asks for a settings zip to import.
func (a *app) pickSettingsZip() {
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{".zip"}}, func(files []core.File, err error) {
		switch {
		case err != nil:
			a.toast(ui.ToastError, "选择文件失败", err.Error())
		case len(files) == 0:
			return
		default:
			a.importSettings(files[0].Path)
		}
	})
}
