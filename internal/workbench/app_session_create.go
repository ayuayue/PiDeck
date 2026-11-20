//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// blankSession builds a session's signals and registers it.
func (a *app) blankSession(id string, ws *workspace, title string) *session {
	s := &session{
		ID:             id,
		WS:             ws.Path,
		Target:         ws.Target,
		title:          core.NewSignal(a.cx, title),
		status:         core.NewSignal(a.cx, statusIdle),
		turns:          core.NewSignalFunc(a.cx, []turn{}, nil),
		draft:          core.NewSignal(a.cx, ""),
		images:         core.NewSignalFunc(a.cx, []remotewire.Image(nil), nil),
		model:          core.NewSignal(a.cx, modelInfo{}),
		models:         core.NewSignalFunc(a.cx, []modelInfo(nil), nil),
		modelsBusy:     core.NewSignal(a.cx, false),
		thinking:       core.NewSignal(a.cx, ""),
		levels:         core.NewSignalFunc(a.cx, []string(nil), nil),
		usage:          core.NewSignal(a.cx, usageInfo{}),
		stats:          core.NewSignal(a.cx, sessionStats{}),
		updated:        core.NewSignal(a.cx, a.cx.Now()),
		loaded:         core.NewSignal(a.cx, false),
		notice:         core.NewSignal(a.cx, ""),
		steering:       core.NewSignalFunc(a.cx, []string(nil), nil),
		sending:        core.NewSignalFunc(a.cx, []queuedMessage(nil), nil),
		ask:            core.NewSignalFunc(a.cx, (*extensionAsk)(nil), nil),
		askPending:     core.NewSignal(a.cx, 0),
		askUI:          core.NewSignalFunc(a.cx, askUIState{}, nil),
		askTexts:       core.NewSignalFunc(a.cx, map[string]string(nil), nil),
		window:         core.NewSignal(a.cx, 24),
		todos:          core.NewSignalFunc(a.cx, []todoItem(nil), nil),
		todoOpen:       core.NewSignal(a.cx, false),
		extWidgets:     map[string][]string{},
		runningSig:     core.NewSignal(a.cx, false),
		agentMode:      core.NewSignal(a.cx, modeNormal),
		sendMode:       core.NewSignal(a.cx, ""),
		goalPaused:     core.NewSignal(a.cx, false),
		readySig:       core.NewSignal(a.cx, false),
		modelOpen:      core.NewSignal(a.cx, false),
		modelQuery:     core.NewSignal(a.cx, ""),
		backendOpen:    core.NewSignal(a.cx, false),
		modeOpen:       core.NewSignal(a.cx, false),
		imageOpen2:     core.NewSignal(a.cx, false),
		toolsOpen:      core.NewSignal(a.cx, false),
		sendOpen:       core.NewSignal(a.cx, false),
		usageOpen:      core.NewSignal(a.cx, false),
		projectOpen:    core.NewSignal(a.cx, false),
		streamText:     core.NewSignal(a.cx, ""),
		streamThinking: core.NewSignal(a.cx, ""),
		liveTools:      core.NewSignalFunc(a.cx, []toolRun(nil), nil),
		extStatus:      map[string]string{},
		openTools:      map[string]bool{},
		uiSeq:          core.NewSignal(a.cx, 0),
		acpCommands:    core.NewSignalFunc(a.cx, []acpCommand(nil), nil),
		acpMode:        core.NewSignal(a.cx, ""),
		acpModes:       core.NewSignalFunc(a.cx, []acpMode(nil), nil),
		acpModeOpen:    core.NewSignal(a.cx, false),
	}
	s.conversation = newChatScroll(a.cx)
	a.byID[s.ID] = s
	a.all = append(a.all, s)
	return s
}

// newSession starts an empty conversation in the active workspace, or in
// the one at path.
func (a *app) newSession(path string) *session {
	ws := a.activeWorkspace()
	if path != "" {
		for _, w := range a.workspaces.Get() {
			if w.Path == path {
				ws = w
				break
			}
		}
	}
	if ws == nil {
		// No project yet: the folder picker is the next step, not an error.
		a.toast(ui.ToastInfo, "先选一个项目", "选好文件夹就开始第一次对话。")
		a.pickNative("workspace")
		return nil
	}
	title := "新会话"
	if ws.Chat {
		title = apptext.T("对话")
	}
	s := a.blankSession(newSessionID(), ws, title)
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
	origin := "project"
	if ws.Chat {
		origin = "chat"
	}
	a.sessionCreated(s, origin)
	return s
}
