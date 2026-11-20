//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"fmt"
	"slices"
	"strings"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// openPicker shows the app's own folder browser for a workspace or a
// session file.
func (a *app) openPicker(mode string) {
	if mode == "import" {
		// One dialog at a time: the import dialog is a modal, and leaving it
		// up would put its backdrop over the browser it just opened.
		a.impOpen.Set(false)
	}
	a.pick.show(mode)
}

// pickNative shows the system's own picker: a folder for a workspace, or a
// session file to import. It is the quick path; the app's browser stays for
// typing a path or seeing what a folder holds.
func (a *app) pickNative(mode string) {
	switch mode {
	case "image":
		a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp", ".gif"}}, func(files []core.File, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择图片失败", err.Error())
			case len(files) == 0:
				// Cancelled.
			default:
				a.visionPath.Set(files[0].Path)
			}
		})
	case "image-ref":
		a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp"}}, func(files []core.File, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择图片失败", err.Error())
			case len(files) == 0:
				// Cancelled.
			default:
				a.imageRef.Set(files[0].Path)
			}
		})
	case "import":
		a.cx.PickFiles(core.PickFilesOptions{Types: []string{".jsonl"}}, func(files []core.File, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择文件失败", err.Error())
			case len(files) == 0:
				// Cancelled.
			default:
				a.importSession(files[0].Path)
			}
		})
	default:
		a.cx.PickDirectories(core.PickDirectoriesOptions{}, func(dirs []core.Directory, err error) {
			switch {
			case err != nil:
				a.toast(ui.ToastError, "选择文件夹失败", err.Error())
			case len(dirs) == 0:
				// Cancelled.
			case dirs[0].Path == "":
				a.toast(ui.ToastWarning, "这个文件夹没有路径", "换一个本机的文件夹试试。")
			default:
				a.addWorkspace(dirs[0].Path)
			}
		})
	}
}

// pickerChosen handles the browser's choice.
func (a *app) pickerChosen(path string) {
	mode := a.pick.mode.GetUntracked()
	a.pick.open.Set(false)
	switch mode {
	case "workspace":
		a.addWorkspace(path)
	case "import":
		a.importSession(path)
	}
}

// addWorkspace adds a folder on this machine to the rail.
func (a *app) addWorkspace(path string) { a.addWorkspaceFor(localTarget, path, "") }

// addWorkspaceFor adds a folder on a target to the rail.
func (a *app) addWorkspaceFor(t target, path, name string) {
	path = cleanTargetPath(t, path)
	if path == "" {
		return
	}
	if ws := a.workspaceFor(t, path); ws != nil {
		ws.Expanded.Set(true)
		a.activeWS.Set(projectWireKey(ws))
		if !t.remote() {
			a.files.watch(path)
		}
		if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
			a.git.attach(ws)
		}
		return
	}
	ws := &workspace{Path: path, Name: name, Target: t, Added: a.cx.Now(), Expanded: core.NewSignal(a.cx, true),
		Sessions:  core.NewSignalFunc(a.cx, []*session{}, nil),
		Pi:        core.NewSignalFunc(a.cx, []*session(nil), nil),
		PiOpen:    core.NewSignal(a.cx, true),
		PiLoading: core.NewSignal(a.cx, false),
		Visible:   core.NewSignal(a.cx, 0)}
	a.workspaces.Update(func(list []*workspace) []*workspace { return append(list, ws) })
	a.activeWS.Set(projectWireKey(ws))
	if !t.remote() {
		a.files.watch(path)
	}
	a.st.edit(func(c *config) {
		for _, w := range c.Workspaces {
			if w.Path == path && w.Target == t.key() {
				return
			}
		}
		c.Workspaces = append(c.Workspaces, workspaceCfg{Path: path, Name: name, Target: t.key(), Expanded: true, Added: ws.Added})
	})
	if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
		a.git.attach(ws)
	}
	a.toast(ui.ToastSuccess, "已添加工作区", t.label()+" · "+path)
	a.rescanPi()
	if t.remote() {
		a.scanProject(ws)
	}
}

// addRemoteWorkspace adds the folder the remote dialog names.
func (a *app) addRemoteWorkspace() {
	kind := targetKind(a.addKind.GetUntracked())
	where := strings.TrimSpace(a.addWhere.GetUntracked())
	path := strings.TrimSpace(a.addPath.GetUntracked())
	if where == "" || path == "" {
		a.toast(ui.ToastWarning, "还差一点", "选一个目标，再填它的目录。")
		return
	}
	t := target{Kind: targetWSL, Distro: where}
	if kind == targetSSH {
		t = target{Kind: targetSSH, Host: where}
	}
	a.addTarget.Set(false)
	a.addWorkspaceFor(t, path, "")
}

// removeWorkspace takes a folder out of the rail; its sessions stay on disk.
func (a *app) removeWorkspace(ws *workspace) {
	if ws == nil {
		return
	}
	a.askConfirm("移除工作区", fmt.Sprintf("从侧栏移除「%s」？会话文件仍保留在磁盘上。", ws.label()), "移除", func() {
		a.removeWorkspaceNow(ws)
	})
}

// removeWorkspaceNow takes a folder off the rail, without asking: the
// phone's removal comes in already confirmed.
func (a *app) removeWorkspaceNow(ws *workspace) {
	if ws == nil {
		return
	}
	a.removeWorkspacesNow(map[string]bool{trustKey(ws): true})
}

func (a *app) removeWorkspacesNow(keys map[string]bool) {
	if len(keys) == 0 || a.st == nil {
		return
	}
	a.cx.Batch(func() {
		removed := make(map[string]bool)
		for _, s := range a.all {
			if !keys[s.Target.key()+"|"+s.WS] {
				continue
			}
			removed[s.ID] = true
			delete(a.byID, s.ID)
			if s.stopDraft != nil {
				s.stopDraft()
				s.stopDraft = nil
			}
			if s.engine != nil {
				go s.engine.stop()
				s.engine = nil
			}
			if s.backend == "acp" {
				a.detachACP(s)
			}
		}
		a.all = slices.DeleteFunc(a.all, func(s *session) bool { return removed[s.ID] })
		a.closedTabs = slices.DeleteFunc(a.closedTabs, func(id string) bool { return removed[id] })
		a.workspaces.Update(func(list []*workspace) []*workspace {
			return slices.DeleteFunc(slices.Clone(list), func(w *workspace) bool { return keys[trustKey(w)] })
		})
		a.st.edit(func(c *config) {
			c.Workspaces = slices.DeleteFunc(c.Workspaces, func(w workspaceCfg) bool { return keys[w.Target+"|"+w.Path] })
		})
		kept := slices.DeleteFunc(slices.Clone(a.tabs.GetUntracked()), func(id string) bool { return removed[id] })
		a.tabs.Set(kept)
		if removed[a.activeID.GetUntracked()] {
			if len(kept) > 0 {
				a.selectSession(a.byID[kept[len(kept)-1]])
			} else {
				a.activeWS.Set("")
				a.activeID.Set("")
				a.git.attach(nil)
			}
		}
		a.remember()
	})
}
