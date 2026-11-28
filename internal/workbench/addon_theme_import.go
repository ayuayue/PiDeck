//go:build !js && !android && !ios

package workbench

// Looks and add-ons. A theme is a set of palette roles and design tokens
// over the app's own; a plugin is a folder of JSON that adds themes.
// Neither runs code, so importing a theme file a friend sent can only be
// dull, not dangerous: it is read as data and copied into the app's own
// themes folder.

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// maxThemeFile bounds an imported theme: what a look writes is a few
// kilobytes of roles, tokens and fonts.
const maxThemeFile = 1 << 20

// themeFileTypes are the extensions a theme may come in.
var themeFileTypes = []string{".json", ".yaml", ".yml"}

var (
	errThemeEmpty = errors.New("主题文件是空的")
	errThemeLarge = errors.New("主题文件太大")
	errThemeKind  = errors.New("不是主题文件")
	errThemeBlank = errors.New("文件里没有配色、字体或圆角")
)

// importTheme asks for a theme file and copies it into the app's themes
// folder, where the app reads it like one it exported itself.
func (a *app) importTheme() {
	dir := a.themesDir()
	if dir == "" {
		a.toast(ui.ToastError, "找不到主题目录", "")
		return
	}
	a.cx.PickFiles(core.PickFilesOptions{Types: themeFileTypes, Limit: 1,
		Title: apptext.T("选择主题文件"), TypesName: apptext.T("主题")}, func(files []core.File, err error) {
		if err != nil {
			a.toast(ui.ToastError, "选择主题文件失败", err.Error())
			return
		}
		if len(files) == 0 || files[0].Path == "" {
			return
		}
		path := files[0].Path
		go func() {
			spec, err := importThemeFile(dir, path)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "主题没能导入", themeImportError(err))
					return
				}
				a.reloadAddons()
				a.toastAction(ui.ToastSuccess, "已导入主题", spec.Name, "应用", func() { a.setTheme(spec.ID) })
			})
		}()
	})
}

// importThemeFile validates a theme file and copies it into dir under a
// name that is free, so importing twice keeps both looks. It reads the file
// before writing anything, and writes it whole or not at all.
func importThemeFile(dir, path string) (themeSpec, error) {
	info, err := os.Stat(path)
	if err != nil {
		return themeSpec{}, err
	}
	name := filepath.Base(path)
	if !isThemeFile(name) || name == "." || name == string(filepath.Separator) {
		return themeSpec{}, errThemeKind
	}
	if info.Size() <= 0 {
		return themeSpec{}, errThemeEmpty
	}
	if info.Size() > maxThemeFile {
		return themeSpec{}, errThemeLarge
	}
	// Read it as the app would read it where it lands: a file that only
	// parses under its old name would fail later, once it is in the folder.
	spec, err := parseThemeFile(path, fileBase(name))
	if err != nil {
		return themeSpec{}, err
	}
	if spec.blank() {
		return themeSpec{}, errThemeBlank
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return themeSpec{}, err
	}
	target, err := freeFileIn(dir, name)
	if err != nil {
		return themeSpec{}, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return themeSpec{}, err
	}
	if err := writeFileAtomic(target, raw, 0o644); err != nil {
		return themeSpec{}, err
	}
	// The look the app will list is the copy, not the file it came from.
	copied, err := parseThemeFile(target, fileBase(target))
	if err != nil {
		return themeSpec{}, err
	}
	copied.ID = "user:" + firstNonEmpty(copied.ID, fileBase(target))
	return copied, nil
}

// blank reports a theme that carries nothing: a file with keys the app does
// not read would otherwise join the list as a second copy of the base look.
func (t themeSpec) blank() bool {
	return len(t.Light) == 0 && len(t.Dark) == 0 && len(t.Tokens) == 0 &&
		len(t.LightColors) == 0 && len(t.DarkColors) == 0 && t.Radius == 0 &&
		t.Sans == "" && t.Mono == ""
}

// freeFileIn is name in dir, or name with a number before its extension
// when that name is taken: an import never overwrites a theme already
// there.
func freeFileIn(dir, name string) (string, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i < 100; i++ {
		candidate := name
		if i > 1 {
			candidate = stem + "-" + strconv.Itoa(i) + ext
		}
		path := filepath.Join(dir, candidate)
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return path, nil
		} else if err != nil {
			return "", err
		}
	}
	return "", errors.New("主题目录里同名文件太多")
}

// themeImportError says why a theme file was refused, in the app's words.
func themeImportError(err error) string {
	switch {
	case errors.Is(err, errThemeEmpty):
		return apptext.T("这个文件是空的。")
	case errors.Is(err, errThemeLarge):
		return apptext.T("主题文件超过 1 MB，多半不是主题。")
	case errors.Is(err, errThemeKind):
		return apptext.T("主题文件要以 .json、.yaml 或 .yml 结尾。")
	case errors.Is(err, errThemeBlank):
		return apptext.T("文件里没有配色、字体或圆角，读不出一个主题。")
	}
	return err.Error()
}
