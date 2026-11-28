//go:build !js && !android && !ios

package workbench

// The built-in chat: a real folder under the app's data that holds
// conversations which belong to no project. It is a workspace like any
// other, so pi keeps its sessions and the file drawer has somewhere to
// look, but it is made on first use and shown in the rail's chat column
// instead of among the projects.

import (
	"os"
	"path/filepath"

	"example.com/pideck/internal/apptext"
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

// chatWorkspace is the built-in chat's project, nil before it was made.
func (a *app) chatWorkspace() *workspace {
	dir := a.chatDir()
	if dir == "" {
		return nil
	}
	return a.workspaceFor(localTarget, dir)
}

// ensureChatWorkspace makes the chat folder and its project on first use.
func (a *app) ensureChatWorkspace() *workspace {
	if ws := a.chatWorkspace(); ws != nil {
		return ws
	}
	dir := a.chatDir()
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "无法创建内置对话目录", err.Error())
		return nil
	}
	ws := &workspace{Path: dir, Name: apptext.T("对话"), Chat: true, Pinned: true, Target: localTarget, Added: a.cx.Now(),
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
	return ws
}

// openChat starts a session in the built-in chat folder, making the
// folder and its pseudo project on first use.
func (a *app) openChat() *session {
	ws := a.ensureChatWorkspace()
	if ws == nil {
		return nil
	}
	ws.Expanded.Set(true)
	a.activeWS.Set(projectWireKey(ws))
	return a.newSession(projectWireKey(ws))
}
