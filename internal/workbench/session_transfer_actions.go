//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type sessionTransferState struct {
	Kind, Status, Source, Error                   string
	Done, Total, Imported, Skipped, Failed, Files int
	Visible                                       bool
}

func (s sessionTransferState) running() bool {
	return s.Status == "checking" || s.Status == "scanning" || s.Status == "copying" || s.Status == "saving"
}

func (a *app) transferRunning() bool { return a.transfer != nil && a.transfer.Get().running() }

func (a *app) startLegacyMigration() { a.launchLegacyMigration(false) }

func (a *app) launchLegacyMigration(retry bool) {
	if a.st == nil || a.transfer == nil || a.transfer.GetUntracked().running() {
		return
	}
	st, ctx := a.st, a.lifetime
	a.transfer.Set(sessionTransferState{Kind: "legacy", Status: "checking", Visible: retry})
	if retry {
		a.transferOpen.Set(true)
	}
	go func() {
		record, err := readLegacyMigration(st.dir)
		if err != nil && !retry {
			a.cx.Post(func() { a.showTransferFailure("legacy", record.Source, err) })
			return
		}
		if err != nil {
			record = legacyMigrationRecord{}
		}
		if !retry && record.Status != "running" {
			if record.Status == "completed" || record.Status == "failed" {
				a.cx.Post(func() { a.transfer.Set(transferFromRecord(record)) })
				return
			}
			if record.Status != "" || !st.fresh {
				a.cx.Post(func() { a.transfer.Set(sessionTransferState{}) })
				return
			}
		}
		candidates := legacyMigrationCandidates()
		if record.Source != "" {
			candidates = []string{record.Source}
		}
		source, err := findLegacyMigrationSource(candidates, st.dir)
		if err == nil && source == "" && (retry || os.Getenv("PIDECK_V2_LEGACY_HOME") != "") {
			err = errors.New(apptext.T("没有找到可迁移的旧版数据目录。"))
		}
		if err != nil {
			result := legacyMigrationResult{Record: legacyMigrationRecord{Version: 1, Status: "running", Source: source}, Err: err}
			a.cx.Post(func() { a.finishLegacyMigration(result) })
			return
		}
		if source == "" {
			err = saveLegacyMigration(st.dir, legacyMigrationRecord{Version: 1, Status: "not-found", Finished: time.Now().UTC()})
			a.cx.Post(func() {
				if err != nil {
					a.showTransferFailure("legacy", "", err)
				} else {
					a.transfer.Set(sessionTransferState{})
				}
			})
			return
		}
		a.cx.Post(func() {
			a.transfer.Set(sessionTransferState{Kind: "legacy", Status: "scanning", Source: source, Visible: true})
		})
		last := time.Time{}
		result := runLegacyMigration(ctx, st, source, func(state sessionTransferState) {
			if state.Done != state.Total && time.Since(last) < 100*time.Millisecond {
				return
			}
			last = time.Now()
			a.cx.Post(func() { a.updateTransferProgress(state) })
		})
		if errors.Is(result.Err, context.Canceled) {
			return
		} // running marker resumes next launch
		a.cx.Post(func() { a.finishLegacyMigration(result) })
	}()
}

func (a *app) updateTransferProgress(state sessionTransferState) {
	previous := a.transfer.GetUntracked()
	if previous.Kind == state.Kind && previous.Source == state.Source && previous.running() {
		state.Visible = previous.Visible
	}
	a.transfer.Set(state)
}

func transferFromRecord(record legacyMigrationRecord) sessionTransferState {
	return sessionTransferState{Kind: "legacy", Status: record.Status, Source: record.Source,
		Imported: record.Imported, Skipped: record.Skipped, Files: record.Files, Error: record.Error,
		Visible: record.Status == "failed"}
}

func (a *app) finishLegacyMigration(result legacyMigrationResult) {
	a.mergeTransferredSessions(result.Sessions, result.Snapshot.Projects, result.Titles, result.Pinned)
	state := a.transfer.GetUntracked()
	state.Kind, state.Status, state.Source, state.Visible = "legacy", "saving", result.Record.Source, true
	a.transfer.Set(state)
	go func() {
		err := errors.Join(result.Err, a.st.save())
		record := result.Record
		record.Status, record.Finished = "completed", time.Now().UTC()
		if err != nil {
			record.Status, record.Error = "failed", shorten(err.Error(), 2000)
		}
		if saveErr := saveLegacyMigration(a.st.dir, record); saveErr != nil {
			err = errors.Join(err, saveErr)
		}
		a.cx.Post(func() {
			state := transferFromRecord(record)
			state.Visible = true
			if err != nil {
				state.Status, state.Error = "failed", shorten(err.Error(), 2000)
			}
			a.transfer.Set(state)
			a.refreshReplyShortcuts(nil)
			if err != nil {
				a.toastAction(ui.ToastWarning, apptext.T("旧版数据迁移未完成"), apptext.T("已保留成功导入的数据。可重试，或从会话目录手动导入。"), apptext.T("查看详情"), func() { a.transferOpen.Set(true) })
			} else {
				a.toastAction(ui.ToastSuccess, apptext.T("旧版数据迁移完成"), a.transferSummary(state), apptext.T("查看详情"), func() { a.transferOpen.Set(true) })
			}
		})
	}()
}

func (a *app) showTransferFailure(kind, source string, err error) {
	a.transfer.Set(sessionTransferState{Kind: kind, Status: "failed", Source: source, Error: shorten(err.Error(), 2000), Visible: true})
	a.toastAction(ui.ToastWarning, apptext.T("数据导入未完成"), apptext.T("可查看失败原因，并从会话目录手动导入。"), apptext.T("查看详情"), func() { a.transferOpen.Set(true) })
}

func (a *app) pickSessionDirectory() {
	if a.st == nil || a.transferRunning() {
		return
	}
	a.cx.PickDirectories(core.PickDirectoriesOptions{}, func(dirs []core.Directory, err error) {
		if err != nil {
			a.showTransferFailure("directory", "", err)
			return
		}
		if len(dirs) == 0 {
			return
		}
		if dirs[0].Path == "" {
			a.showTransferFailure("directory", "", errors.New(apptext.T("这个文件夹没有路径")))
			return
		}
		a.impOpen.Set(false)
		a.transferOpen.Set(true)
		a.importSessionDirectory(dirs[0].Path)
	})
}

func (a *app) importSessionDirectory(root string) {
	if a.st == nil || a.transferRunning() {
		return
	}
	a.transfer.Set(sessionTransferState{Kind: "directory", Status: "scanning", Source: root, Visible: true})
	ctx, st := a.lifetime, a.st
	go func() {
		files, scanErr := scanPiTransferFiles(ctx, []string{root})
		last := time.Time{}
		result := st.transferPiSessions(ctx, files, nil, nil, func(p piTransferProgress) {
			if p.Done != p.Total && time.Since(last) < 100*time.Millisecond {
				return
			}
			last = time.Now()
			state := sessionTransferState{Kind: "directory", Status: "copying", Source: root, Visible: true,
				Done: p.Done, Total: p.Total, Imported: p.Imported, Skipped: p.Skipped, Failed: p.Failed}
			a.cx.Post(func() { a.updateTransferProgress(state) })
		})
		if ctx.Err() != nil {
			return
		}
		err := errors.Join(scanErr, result.Err)
		if err == nil && len(result.BySource) == 0 {
			err = errors.New(apptext.T("所选目录中没有可导入的 pi 会话，请选择会话文件所在目录。"))
		}
		a.cx.Post(func() {
			var metas []sessionMeta
			for _, meta := range result.BySource {
				metas = append(metas, meta)
			}
			a.mergeTransferredSessions(metas, nil, nil, nil)
			state := sessionTransferState{Kind: "directory", Status: "saving", Source: root, Visible: true,
				Done: len(files), Total: len(files), Imported: result.Imported, Skipped: result.Skipped, Failed: result.Failed}
			a.transfer.Set(state)
			go func() {
				err = errors.Join(err, st.save())
				a.cx.Post(func() {
					state.Status = "completed"
					if err != nil {
						state.Status, state.Error = "failed", shorten(err.Error(), 2000)
					}
					a.transfer.Set(state)
					kind, title := ui.ToastSuccess, apptext.T("目录会话导入完成")
					if err != nil {
						kind, title = ui.ToastWarning, apptext.T("数据导入未完成")
					}
					a.toastAction(kind, title, a.transferSummary(state), apptext.T("查看详情"), func() { a.transferOpen.Set(true) })
				})
			}()
		})
	}()
}

// Merge on the graph goroutine so projects, titles and pins changed while
// copying take precedence. No per-session toast, disk write or backend launch.
func (a *app) mergeTransferredSessions(metas []sessionMeta, projects []workspaceCfg, titles map[string]string, pins []string) {
	workspaces := append([]*workspace(nil), a.workspaces.GetUntracked()...)
	byPath := map[string]*workspace{}
	for _, ws := range workspaces {
		if !ws.Target.remote() {
			byPath[pathKey(ws.Path)] = ws
		}
	}
	addProject := func(wc workspaceCfg) *workspace {
		key := pathKey(wc.Path)
		if ws := byPath[key]; ws != nil {
			return ws
		}
		if wc.Path == "" {
			return nil
		}
		if key == pathKey(filepath.Join(a.st.dir, "chat")) {
			wc.Chat, wc.Pinned = true, true
			wc.Name = apptext.T("对话")
		}
		ws := &workspace{Path: wc.Path, Name: wc.Name, Chat: wc.Chat, Pinned: wc.Pinned, Added: wc.Added,
			Expanded: core.NewSignal(a.cx, true), Sessions: core.NewSignalFunc(a.cx, []*session{}, nil),
			Pi: core.NewSignalFunc(a.cx, []*session(nil), nil), PiOpen: core.NewSignal(a.cx, false),
			PiLoading: core.NewSignal(a.cx, false), Visible: core.NewSignal(a.cx, 0)}
		workspaces, byPath[key] = append(workspaces, ws), ws
		return ws
	}
	for _, wc := range projects {
		addProject(wc)
	}
	for _, meta := range metas {
		ws := addProject(workspaceCfg{Path: meta.Cwd})
		if ws == nil {
			continue
		}
		if existing := a.byID[meta.ID]; existing != nil {
			if existing.WS != meta.Cwd || existing.Target.remote() {
				continue
			}
			if existing.External {
				// Never redirect a live reader or backend during a transfer.
				// An idle listed session can adopt the copy without losing its tab or draft.
				if existing.engine != nil || existing.hasAgent() || existing.busyNow() || existing.historyLoading || existing.agentStopping || existing.deleting || existing.retryPendingNow() {
					continue
				}
				existing.File, existing.External = meta.File, false
				ws.Pi.Set(slices.DeleteFunc(append([]*session(nil), ws.Pi.GetUntracked()...), func(s *session) bool { return s.ID == meta.ID }))
				a.bumpSessionUI(existing)
			}
		}
		sess := a.makeSession(meta, localTarget)
		list := ws.Sessions.GetUntracked()
		if !slices.Contains(list, sess) {
			ws.Sessions.Set(append(list, sess))
		}
	}
	a.workspaces.Set(workspaces)
	a.st.change(func(c *config) {
		for _, ws := range workspaces {
			if slices.ContainsFunc(c.Workspaces, func(w workspaceCfg) bool { return w.Target == ws.Target.key() && pathKey(w.Path) == pathKey(ws.Path) }) {
				continue
			}
			c.Workspaces = append(c.Workspaces, workspaceCfg{Path: ws.Path, Name: ws.Name, Pinned: ws.Pinned, Chat: ws.Chat, Added: ws.Added, Expanded: true})
		}
		for id, title := range titles {
			if c.Titles[id] == "" {
				c.Titles[id] = title
			}
		}
		for _, id := range pins {
			if !slices.Contains(c.Pinned, id) {
				c.Pinned = append(c.Pinned, id)
			}
		}
	})
	a.cfg = a.st.config()
	a.pinned.Set(a.cfg.Pinned)
	for _, meta := range metas {
		if title := a.cfg.Titles[meta.ID]; title != "" {
			if sess := a.byID[meta.ID]; sess != nil {
				sess.title.Set(title)
			}
		}
	}
	a.projectsRev.Update(func(n int) int { return n + 1 })
	a.bumpSettings()
}

func (a *app) transferSummary(s sessionTransferState) string {
	return fmt.Sprintf(apptext.T("会话：导入 %d 个，跳过 %d 个；聊天文件：复制 %d 个。"), s.Imported, s.Skipped, s.Files)
}
