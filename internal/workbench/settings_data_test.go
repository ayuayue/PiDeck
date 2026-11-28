//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDataSettingsStorageAndLayout(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		info := built.env.GetUntracked()
		info.SessionsDir = filepath.Join(t.TempDir(), strings.Repeat("long-project-name-", 10), "sessions")
		built.env.Set(info)
		built.openSettingsPane()
		built.openSettingsSection("data")
	})
	screen.WaitFor("id:settings-export", 5*time.Second)
	for _, selector := range []string{"id:settings-sync", "text:配置版本", "text:项目下的 pi 本地会话"} {
		if len(screen.QueryMounted(selector)) != 0 {
			t.Fatalf("data page still exposes %s", selector)
		}
	}
	if len(screen.Query("id:data-copy-data")) != 0 {
		t.Fatal("storage paths should be collapsed initially")
	}
	screen.Press("role:button 存储位置")
	screen.WaitFor("id:data-copy-data", 5*time.Second)
	if nsgotest.Target() == "" {
		screen.Press("id:data-copy-data")
		if screen.Clipboard != built.st.dir {
			t.Fatalf("copied path = %q, want %q", screen.Clipboard, built.st.dir)
		}
	}
	for _, width := range []core.Points{1200, 900} {
		screen.Resize(width, 800)
		page := screen.Find("id:settings-page").Bounds()
		for _, id := range []string{"settings-export", "settings-import", "data-manage-sessions", "data-import-sessions", "data-open-exports", "data-copy-pi", "data-open-pi", "cache-clear-all", "data-manage-logs"} {
			bounds := screen.FindMounted("id:" + id).Bounds()
			if bounds.Origin.X < page.Origin.X || bounds.Origin.X+bounds.Size.Width > page.Origin.X+page.Size.Width-viewkit.PanelInset {
				t.Fatalf("%s overflows the content or scrollbar inset at width %g: page=%+v control=%+v", id, width, page, bounds)
			}
		}
	}
	onNativeUI(t, screen, built, func() {
		info := built.env.GetUntracked()
		info.SessionsDir = ""
		built.env.Set(info)
	})
	if len(screen.QueryMounted("id:data-open-pi")) != 0 {
		t.Fatal("an unavailable pi folder must not leave an empty action")
	}
}

func TestDataSettingsSearchAndLogNavigation(t *testing.T) {
	for _, query := range []string{"加密同步", "配置版本", "encrypted sync"} {
		for _, hit := range searchSettings(query) {
			if hit.Section == "data" {
				t.Fatalf("hidden data setting still appears for %q: %+v", query, hit)
			}
		}
	}
	for _, query := range []string{"备份设置", "恢复设置", "管理会话", "导入会话", "导出文件", "清理缓存"} {
		found := false
		for _, hit := range searchSettings(query) {
			found = found || hit.Section == "data"
		}
		if !found {
			t.Errorf("data action cannot be found with %q", query)
		}
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() { built.openSettingsPane(); built.openSettingsSection("data") })
	screen.Press("id:data-manage-logs")
	screen.WaitFor("id:diag-tab-logs", 5*time.Second)
	if built.settingsTab.GetUntracked() != "diagnostics" {
		t.Fatal("manage logs did not open diagnostics")
	}
}

func TestDataSettingsExportFailureRecovers(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	exports := filepath.Join(built.st.dir, "exports")
	if err := os.WriteFile(exports, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, built, func() { built.openSettingsPane(); built.openSettingsSection("data") })
	screen.Press("id:settings-export")
	screen.WaitFor("text:导出设置失败", 5*time.Second)
	if screen.Find("id:settings-export").Props.Disabled {
		t.Fatal("a failed export left the action disabled")
	}
	screen.Press("id:data-open-exports")
	screen.WaitFor("text:打不开文件夹", 5*time.Second)
	if screen.Find("id:data-open-exports").Props.Disabled {
		t.Fatal("a failed folder action left the action disabled")
	}
	if err := os.Remove(exports); err != nil {
		t.Fatal(err)
	}
	if nsgotest.Target() == "" {
		// The headless host records the request without opening a real file manager.
		screen.Press("id:data-open-exports")
		screen.WaitUntil(5*time.Second, func() bool {
			info, err := os.Stat(exports)
			return err == nil && info.IsDir() && !screen.Find("id:data-open-exports").Props.Disabled
		})
	}
	screen.Press("id:settings-export")
	screen.WaitUntil(5*time.Second, func() bool {
		files, err := filepath.Glob(filepath.Join(exports, "settings-*.zip"))
		return err == nil && len(files) == 1 && !screen.Find("id:settings-export").Props.Disabled
	})
}

func TestDataSettingsScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() { built.openSettingsPane(); built.openSettingsSection("data") })
	screen.Resize(1200, 850)
	screen.WaitFor("id:settings-export", 5*time.Second)
	shot(screen, "data-redesign/light")
	screen.Resize(900, 720)
	shot(screen, "data-redesign/narrow")
	screen.Press("role:button 存储位置")
	screen.WaitFor("id:data-open-data", 5*time.Second)
	screen.Scroll("id:settings-page", 250)
	shot(screen, "data-redesign/locations")
	onNativeUI(t, screen, built, func() { built.theme.Set("dark"); built.applyTheme() })
	shot(screen, "data-redesign/dark")
}
