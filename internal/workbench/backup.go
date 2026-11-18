//go:build !js && !android && !ios

package workbench

// A settings backup: config and the add-on folders in one zip. Sessions,
// logs and exports stay out, so a backup is small and safe to share.

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// backupItems are the data folder's entries a settings backup carries.
var backupItems = []string{"config.json", "plugins", "themes", "prompts", "agents", "acp"}

const (
	backupFileLimit  = 10 << 20
	backupTotalLimit = 50 << 20
)

// exportSettings writes a settings zip under exports/.
func (a *app) exportSettings() {
	if a.st == nil {
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出设置失败", err.Error())
		return
	}
	path := filepath.Join(dir, "settings-"+time.Now().Format("20060102-150405")+".zip")
	if err := a.writeSettingsZip(path); err != nil {
		a.toast(ui.ToastError, "导出设置失败", err.Error())
		return
	}
	a.diagf("info", "已导出设置包到 %s", path)
	a.toastAction(ui.ToastSuccess, "已导出设置包", path, "打开", func() {
		a.cx.OpenURL(fileURL(path), nil)
	})
}

// writeSettingsZip builds the backup at path.
func (a *app) writeSettingsZip(path string) error {
	if a.st == nil {
		return errors.New("找不到数据目录")
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	var total int64
	add := func(full, rel string) error {
		info, err := os.Stat(full)
		if err != nil {
			return err
		}
		if info.IsDir() {
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
		f, err := os.Open(full)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(w, f)
		return err
	}
	for _, item := range backupItems {
		full := filepath.Join(a.st.dir, item)
		info, err := os.Stat(full)
		if err != nil {
			continue
		}
		if !info.IsDir() {
			if err := add(full, item); err != nil {
				_ = zw.Close()
				return err
			}
			continue
		}
		err = filepath.WalkDir(full, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, err := filepath.Rel(a.st.dir, p)
			if err != nil {
				return err
			}
			return add(p, rel)
		})
		if err != nil {
			_ = zw.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return writeFileAtomic(path, buf.Bytes(), 0o644)
}

// backupPathAllowed says whether a zip entry belongs in a settings backup.
func backupPathAllowed(name string) bool {
	name = filepath.ToSlash(strings.TrimPrefix(name, "./"))
	if name == "config.json" {
		return true
	}
	head := strings.SplitN(name, "/", 2)[0]
	for _, item := range backupItems {
		if item != "config.json" && head == item {
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
	var names []string
	var total int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(f.Name)
		if strings.HasPrefix(name, "/") || strings.Contains(name, "..") || filepath.IsAbs(name) {
			return nil, errors.New("设置包里有不安全的路径：" + f.Name)
		}
		if !f.Mode().IsRegular() {
			return nil, errors.New("设置包里有不支持的文件类型：" + f.Name)
		}
		if !backupPathAllowed(name) {
			continue
		}
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
			if err := a.applySettingsZip(path); err != nil {
				a.toast(ui.ToastError, "导入设置失败", err.Error())
				return
			}
			if err := a.st.reload(); err != nil {
				a.toast(ui.ToastError, "导入设置失败", err.Error())
				return
			}
			a.cfg = a.st.config()
			a.applyBrand()
			a.chatWidthPctSig.Set(a.cfg.ChatWidthPct)
			a.applyLanguage()
			a.applyFonts()
			a.prompts.Set(a.loadPrompts())
			a.reloadAddons()
			a.toast(ui.ToastSuccess, "已导入设置包", "插件、主题与提示词已重新读取。")
		})
}

// applySettingsZip extracts a validated settings zip over the data folder.
func (a *app) applySettingsZip(path string) error {
	if a.st == nil {
		return errors.New("找不到数据目录")
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := filepath.ToSlash(f.Name)
		if !backupPathAllowed(name) || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			continue
		}
		dest := filepath.Join(a.st.dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
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
		if err := writeFileAtomic(dest, data, 0o644); err != nil {
			return err
		}
	}
	return nil
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
