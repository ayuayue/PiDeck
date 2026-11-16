//go:build !js

package main

// The built-in chat: a real folder under the app's data that holds
// conversations which belong to no project. It is a workspace like any
// other, so pi keeps its sessions and the file drawer has somewhere to
// look, but it is made on first use and marked in the rail.

import (
	"os"
	"path/filepath"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// chatDir is the folder built-in chats run in.
func (a *app) chatDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "chat")
}

// openChat starts a session in the built-in chat folder, making the
// folder and its pseudo project on first use.
func (a *app) openChat() *session {
	dir := a.chatDir()
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "无法创建内置对话目录", err.Error())
		return nil
	}
	ws := a.workspaceFor(localTarget, dir)
	if ws == nil {
		ws = &workspace{Path: dir, Name: T("对话"), Chat: true, Pinned: true, Target: localTarget, Added: a.cx.Now(),
			Expanded:  core.NewSignal(a.cx, true),
			Sessions:  core.NewSignalFunc(a.cx, []*session{}, nil),
			Pi:        core.NewSignalFunc(a.cx, []*session(nil), nil),
			PiOpen:    core.NewSignal(a.cx, true),
			PiLoading: core.NewSignal(a.cx, false),
			Visible:   core.NewSignal(a.cx, 0)}
		a.workspaces.Update(func(list []*workspace) []*workspace { return append(list, ws) })
		a.trustProject(ws)
		a.files.watch(dir)
		a.saveProjects()
		a.rescanPi()
	}
	ws.Expanded.Set(true)
	a.activeWS.Set(dir)
	return a.newSession(dir)
}
