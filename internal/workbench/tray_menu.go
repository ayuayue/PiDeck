//go:build !js && !android && !ios

package workbench

// The tray menu: what the icon offers without opening the window. It
// follows PiDeck's shape — the version, the update, the window, what is
// running, the sessions and projects last used, the phone, the scheduled
// tasks, the pet, the folders, the settings, restart and quit — and the
// platform builds it again each time the menu opens, so its lists are the
// ones current then.

import (
	"path/filepath"
	"sort"
	"strings"
	"time"

	"example.com/pideck-lite/internal/appinfo"
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/desktop"
	"github.com/nsgo-dev/nsgo/updater"
)

// How many entries a tray list carries: enough to reach the last thing
// used, few enough to stay a menu.
const (
	trayRecentSessions = 6
	trayRecentProjects = 6
	trayTasks          = 6
)

// trayMenu is what the tray icon's menu shows.
func (a *app) trayMenu() []desktop.MenuItem {
	items := []desktop.MenuItem{
		{Label: apptext.T("PiDeck Lite %s", appinfo.Version), Disabled: true},
		{Label: apptext.T("检查更新…"), OnSelect: func() {
			a.showMainWindow()
			updater.Check(a.cx)
		}},
		{Separator: true},
		{Label: apptext.T("显示 PiDeck Lite"), OnSelect: a.showMainWindow},
		{Label: apptext.T("新建会话"), OnSelect: func() {
			a.showMainWindow()
			a.newSession(a.activeWS.GetUntracked())
		}},
	}
	if item, ok := a.trayRunning(); ok {
		items = append(items, desktop.MenuItem{Separator: true}, item)
	}
	if item, ok := a.traySessions(); ok {
		items = append(items, item)
	}
	if item, ok := a.trayProjects(); ok {
		items = append(items, item)
	}
	if item, ok := a.trayPhone(); ok {
		items = append(items, desktop.MenuItem{Separator: true}, item)
	}
	if item, ok := a.trayScheduled(); ok {
		items = append(items, item)
	}
	items = append(items,
		desktop.MenuItem{Label: apptext.T("桌面宠物"), Checkable: true, Checked: a.cfg.PetEnabled,
			OnSelect: func() { a.togglePet(!a.cfg.PetEnabled) }},
		desktop.MenuItem{Separator: true},
		desktop.MenuItem{Label: apptext.T("打开数据目录"), OnSelect: func() { a.openDataFolder() }},
		desktop.MenuItem{Label: apptext.T("打开日志目录"), OnSelect: func() { a.openLogsFolder() }},
		desktop.MenuItem{Separator: true},
		desktop.MenuItem{Label: apptext.T("设置…"), OnSelect: func() { a.showMainWindow(); a.openSettingsPane() }},
		desktop.MenuItem{Label: apptext.T("重启"), OnSelect: a.restartApp},
		desktop.MenuItem{Label: apptext.T("退出"), OnSelect: a.quitApp},
	)
	return items
}

// trayRunning lists the turns in flight, each one a jump back to its
// session, and a way to stop them all.
func (a *app) trayRunning() (desktop.MenuItem, bool) {
	running := a.runningSessions()
	if len(running) == 0 {
		return desktop.MenuItem{}, false
	}
	rows := make([]desktop.MenuItem, 0, len(running)+2)
	for _, s := range running {
		s := s
		rows = append(rows, desktop.MenuItem{
			Label:    traySessionLabel(s.title.GetUntracked(), a.trayProjectName(s.WS)),
			OnSelect: func() { a.showMainWindow(); a.selectSession(s) },
		})
	}
	rows = append(rows,
		desktop.MenuItem{Separator: true},
		desktop.MenuItem{Label: apptext.T("全部停止"), OnSelect: func() {
			for _, s := range running {
				a.stop(s)
			}
		}},
	)
	return desktop.MenuItem{Label: apptext.T("运行中 %d 个", len(running)), Items: rows}, true
}

// traySessions lists the sessions last touched, the way the rail orders
// them.
func (a *app) traySessions() (desktop.MenuItem, bool) {
	type row struct {
		s    *session
		when time.Time
	}
	rows := make([]row, 0, len(a.all))
	for _, s := range a.all {
		if s == nil {
			continue
		}
		rows = append(rows, row{s: s, when: s.updated.GetUntracked()})
	}
	if len(rows) == 0 {
		return desktop.MenuItem{Label: apptext.T("最近会话"), Disabled: true}, true
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].when.After(rows[j].when) })
	if len(rows) > trayRecentSessions {
		rows = rows[:trayRecentSessions]
	}
	items := make([]desktop.MenuItem, 0, len(rows))
	for _, r := range rows {
		s := r.s
		items = append(items, desktop.MenuItem{
			Label:    traySessionLabel(s.title.GetUntracked(), a.trayProjectName(s.WS)),
			OnSelect: func() { a.showMainWindow(); a.selectSession(s) },
		})
	}
	return desktop.MenuItem{Label: apptext.T("最近会话"), Items: items}, true
}

// trayProjects lists the projects in the rail's order: picking one shows
// its newest session, as the command palette does.
func (a *app) trayProjects() (desktop.MenuItem, bool) {
	if len(a.workspaces.GetUntracked()) == 0 {
		return desktop.MenuItem{Label: apptext.T("打开项目"), Disabled: true}, true
	}
	items := make([]desktop.MenuItem, 0, trayRecentProjects)
	for i, ws := range a.workspaces.GetUntracked() {
		if i >= trayRecentProjects {
			break
		}
		key := ws.Target.key() + "|" + ws.Path
		items = append(items, desktop.MenuItem{
			Label:    trayProjectLabel(ws.Name, ws.Path),
			OnSelect: func() { a.showMainWindow(); a.openWorkspaceKey(key) },
		})
	}
	return desktop.MenuItem{Label: apptext.T("打开项目"), Items: items}, true
}

// trayPhone offers the address a phone joins on and the code it scans.
func (a *app) trayPhone() (desktop.MenuItem, bool) {
	if a.remote == nil {
		return desktop.MenuItem{}, false
	}
	st := a.remote.state.GetUntracked()
	ip := ""
	if len(st.LAN) > 0 {
		ip = st.LAN[0].Address
	}
	running := st.Running
	items := []desktop.MenuItem{
		{Label: apptext.T("复制连接链接"), Disabled: !running || ip == "", OnSelect: func() {
			a.copyText(a.remote.link(ip), "连接链接")
		}},
		{Label: apptext.T("显示二维码…"), Disabled: !running || ip == "", OnSelect: func() {
			a.showMainWindow()
			a.showQR(a.remote.link(ip))
		}},
		{Separator: true},
		{Label: apptext.T("远程设置…"), OnSelect: func() {
			a.showMainWindow()
			a.openSettingsSection("remote")
		}},
	}
	label := apptext.T("手机连接")
	if running {
		label = apptext.T("手机连接 · %s", ip)
	}
	return desktop.MenuItem{Label: label, Items: items}, true
}

// trayScheduled runs a task now, or opens the page that manages them.
func (a *app) trayScheduled() (desktop.MenuItem, bool) {
	tasks := a.taskList()
	if len(tasks) == 0 {
		return desktop.MenuItem{Label: apptext.T("定时任务"), Disabled: true}, true
	}
	if len(tasks) > trayTasks {
		tasks = tasks[:trayTasks]
	}
	items := make([]desktop.MenuItem, 0, len(tasks)+2)
	for _, t := range tasks {
		id, name := t.ID, t.Name
		item := desktop.MenuItem{
			Label:    name,
			Disabled: !t.Enabled,
			OnSelect: func() { a.runTaskNow(id) },
		}
		items = append(items, item)
	}
	items = append(items,
		desktop.MenuItem{Separator: true},
		desktop.MenuItem{Label: apptext.T("管理定时任务…"), OnSelect: func() {
			a.showMainWindow()
			a.openTaskDialog()
		}},
	)
	return desktop.MenuItem{Label: apptext.T("定时任务"), Items: items}, true
}

// trayProjectName is the name the rail shows for a workspace path.
func (a *app) trayProjectName(path string) string {
	for _, ws := range a.workspaces.GetUntracked() {
		if ws.Path == path {
			return ws.Name
		}
	}
	name, _ := viewkit.SplitGitPath(path)
	return name
}

// trayProjectLabel names a project in a menu: its name, and the last
// segment of its path when the two say different things, so a nested
// folder is not mistaken for another.
func trayProjectLabel(name, path string) string {
	name = strings.TrimSpace(name)
	tail, _ := viewkit.SplitGitPath(path)
	if tail == "" || tail == name {
		return name
	}
	if name == "" {
		return tail
	}
	return name + " · " + tail
}

// traySessionLabel names a session in a menu: its title, and its project
// when one is known.
func traySessionLabel(title, project string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		title = apptext.T("未命名会话")
	}
	if project = strings.TrimSpace(project); project == "" {
		return title
	}
	return title + " · " + project
}

// openDataFolder shows the app's own folder.
func (a *app) openDataFolder() {
	if a.st == nil || a.st.dir == "" {
		return
	}
	a.cx.OpenURL(fileURL(a.st.dir), nil)
}

// openLogsFolder shows where the app's logs are written.
func (a *app) openLogsFolder() {
	if a.st == nil || a.st.dir == "" {
		return
	}
	a.cx.OpenURL(fileURL(filepath.Join(a.st.dir, "logs")), nil)
}

// restartApp relaunches the app, keeping the quit path's cleanup.
func (a *app) restartApp() {
	a.quitting = true
	a.cx.Restart()
}
