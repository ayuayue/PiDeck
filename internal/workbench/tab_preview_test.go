//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"slices"
	"testing"
	"time"
)

func TestTabOpenModeMigration(t *testing.T) {
	for _, tc := range []struct {
		name    string
		version int
		mode    string
		want    string
	}{
		{"legacy", 7, "", tabOpenPreview},
		{"missing", configVersion, "", tabOpenPreview},
		{"invalid", configVersion, "unknown", tabOpenPreview},
		{"fixed", configVersion, tabOpenFixed, tabOpenFixed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := config{Version: tc.version, TabOpenMode: tc.mode, Tabs: []string{"saved"}, LastSession: "saved"}
			migrateConfig(&c, nil)
			if c.Version != configVersion || c.TabOpenMode != tc.want || !slices.Equal(c.Tabs, []string{"saved"}) || c.LastSession != "saved" {
				t.Fatalf("migrated config = %+v; want mode %q and saved tab intact", c, tc.want)
			}
			raw, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			var loaded config
			if err := json.Unmarshal(raw, &loaded); err != nil {
				t.Fatal(err)
			}
			if migrateConfig(&loaded, raw) || loaded.TabOpenMode != tc.want {
				t.Fatalf("saved mode was not stable: mode=%q", loaded.TabOpenMode)
			}
		})
	}
}

func TestPreviewSessionTabs(t *testing.T) {
	project := t.TempDir()
	a, screen := railFixture(t, project)
	var first, second, third *session
	onNativeUI(t, screen, a, func() {
		ws := a.workspaceOf(project)
		first = a.blankSession("preview-first", ws, "第一个预览")
		second = a.blankSession("preview-second", ws, "第二个预览")
		third = a.blankSession("preview-third", ws, "第三个预览")
		ws.Sessions.Set([]*session{first, second, third})
		a.selectSession(first)
		a.selectSession(second)
	})
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 1 })
	onNativeUI(t, screen, a, func() {
		if !slices.Equal(a.tabs.GetUntracked(), []string{second.ID}) || !a.isPreviewTab(second.ID) || a.byID[first.ID] != first {
			t.Fatal("preview did not replace only the old tab while retaining the session")
		}
		if saved := a.st.config(); len(saved.Tabs) != 0 || saved.LastSession != "" {
			t.Fatalf("temporary preview was persisted: tabs=%v active=%q", saved.Tabs, saved.LastSession)
		}
	})
	screen.RightClick("id:tab")
	screen.WaitFor("text:固定标签页", 5*time.Second)
	screen.Press("text:固定标签页")
	onNativeUI(t, screen, a, func() {
		a.selectSession(third)
		a.selectSession(second)
		if !a.isPreviewTab(third.ID) || len(a.tabs.GetUntracked()) != 2 {
			t.Fatal("selecting a fixed tab replaced the background preview")
		}
		if saved := a.st.config(); !slices.Equal(saved.Tabs, []string{second.ID}) || saved.LastSession != second.ID || len(saved.Pinned) != 0 {
			t.Fatalf("tab fixation and sidebar pin diverged: tabs=%v active=%q sidebar=%v", saved.Tabs, saved.LastSession, saved.Pinned)
		}
		a.selectSession(third)
	})
	screen.DoublePress("id:tab >> nth=1")
	onNativeUI(t, screen, a, func() {
		if a.isPreviewTab(third.ID) || !slices.Equal(a.st.config().Tabs, []string{second.ID, third.ID}) {
			t.Fatal("double-click did not fix the preview")
		}
		a.closeTab(third.ID)
		a.reopenTab()
		if a.isPreviewTab(third.ID) || !slices.Contains(a.st.config().Tabs, third.ID) {
			t.Fatal("reopening a closed tab did not retain its fixation")
		}
		a.closeAllTabs()
		a.selectSession(first)
		a.closeTab(first.ID)
		if a.previewTab.GetUntracked() != "" || a.activeID.GetUntracked() != "" {
			t.Fatal("closing the last preview left an active preview behind")
		}
	})
}

func TestGeneralTabOpenMode(t *testing.T) {
	project := t.TempDir()
	a, screen := startNativeSettingsApp(t)
	var first, second, third *session
	onNativeUI(t, screen, a, func() {
		a.addWorkspace(project)
		ws := a.workspaceOf(project)
		first = a.blankSession("mode-first", ws, "方式一")
		second = a.blankSession("mode-second", ws, "方式二")
		third = a.blankSession("mode-third", ws, "方式三")
		a.selectSession(first)
		a.openSettingsPane()
		a.openSettingsSection("general")
	})
	screen.WaitFor("id:tab-open-mode", 5*time.Second)
	screen.Press("id:tab-open-mode")
	screen.Press("id:tab-open-mode-1")
	onNativeUI(t, screen, a, func() {
		if a.cfg.TabOpenMode != tabOpenFixed || a.st.config().TabOpenMode != tabOpenFixed || a.isPreviewTab(first.ID) {
			t.Fatal("fixed mode was not saved or did not promote the open preview")
		}
		a.selectSession(second)
		if a.isPreviewTab(second.ID) || !slices.Contains(a.st.config().Tabs, second.ID) {
			t.Fatal("fixed mode opened a temporary preview")
		}
		a.openSettingsPane()
		a.openSettingsSection("general")
	})
	screen.Press("id:general-layout-reset")
	onNativeUI(t, screen, a, func() {
		a.selectSession(third)
		if a.cfg.TabOpenMode != tabOpenPreview || a.st.config().TabOpenMode != tabOpenPreview || !a.isPreviewTab(third.ID) {
			t.Fatal("layout reset did not restore preview opening")
		}
		if !slices.Contains(a.tabs.GetUntracked(), first.ID) || !slices.Contains(a.tabs.GetUntracked(), second.ID) {
			t.Fatal("switching back to preview changed existing fixed tabs")
		}
	})
}

func TestNewSessionsKeepFixedTabs(t *testing.T) {
	project := t.TempDir()
	a, screen := railFixture(t, project)
	onNativeUI(t, screen, a, func() {
		first := a.newSession(project)
		second := a.newSession(project)
		if first == nil || second == nil || a.isPreviewTab(first.ID) || a.isPreviewTab(second.ID) || !slices.Equal(a.tabs.GetUntracked(), []string{first.ID, second.ID}) {
			t.Fatal("new sessions replaced each other in preview mode")
		}
	})
}

func TestPreviewTabFixesWhenSending(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		a.previewTab.Set(s.ID)
		a.cfg.TrustedProjects = []string{trustKey(a.activeWorkspace())}
		// Hold startup so the real submit path queues without launching a CLI.
		s.starting = true
		a.submit(s, "固定发送中的会话", nil)
		if a.isPreviewTab(s.ID) || !slices.Contains(a.st.config().Tabs, s.ID) {
			t.Fatal("sending from a preview did not fix the session tab")
		}
	})
}
