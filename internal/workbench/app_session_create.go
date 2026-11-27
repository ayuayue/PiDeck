//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// blankSession builds a session's signals and registers it.
func (a *app) blankSession(id string, ws *workspace, title string) *session {
	s := &session{
		ID:          id,
		WS:          ws.Path,
		Created:     a.cx.Now(),
		Target:      ws.Target,
		title:       core.NewSignal(a.cx, title),
		status:      core.NewSignal(a.cx, statusIdle),
		turns:       core.NewSignalFunc(a.cx, []turn{}, nil),
		draft:       core.NewSignal(a.cx, ""),
		draftChange: core.NewSignal(a.cx, (*viewkit.DraftChange)(nil)),
		images:      core.NewSignalFunc(a.cx, []remotewire.Image(nil), nil),
		composing:   core.NewSignal(a.cx, ""),
		pasteFiles:  core.NewSignalFunc(a.cx, []pastedText(nil), nil),
		dropPending: core.NewSignal(a.cx, 0),
		model:       core.NewSignal(a.cx, modelInfo{}),
		models:      core.NewSignalFunc(a.cx, []modelInfo(nil), nil),
		modelsBusy:  core.NewSignal(a.cx, false),
		thinking:    core.NewSignal(a.cx, ""),
		levels:      core.NewSignalFunc(a.cx, []string(nil), nil),
		usage:       core.NewSignal(a.cx, usageInfo{}),
		perf:        core.NewSignal(a.cx, replyPerf{}),
		stats:       core.NewSignal(a.cx, sessionStats{}),
		updated:     core.NewSignal(a.cx, a.cx.Now()),
		// A new session has no transcript to read: it is shown empty at once,
		// instead of waiting behind the history skeleton for pi to start.
		loaded:         core.NewSignal(a.cx, true),
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
		retrying:       core.NewSignal(a.cx, false),
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
		openProc:       map[string]bool{},
		openFold:       map[string]bool{},
		procScroll:     map[string]*processFollow{},
		uiSeq:          core.NewSignal(a.cx, 0),
		acpCommands:    core.NewSignalFunc(a.cx, []acpCommand(nil), nil),
		acpMode:        core.NewSignal(a.cx, ""),
		acpModes:       core.NewSignalFunc(a.cx, []acpMode(nil), nil),
		acpOptions:     core.NewSignalFunc(a.cx, []acpConfigOption(nil), nil),
		acpOptionBusy:  core.NewSignal(a.cx, false),
		acpModeOpen:    core.NewSignal(a.cx, false),
		acpThinkOpen:   core.NewSignal(a.cx, false),
	}
	s.conversation = newChatScroll(a.cx)
	// Model choices are available independently of the session process.
	if chosen := a.defaultModel; chosen.ID != "" {
		s.model.Set(modelInfo{ID: chosen.ID, Provider: chosen.Provider})
	}
	if a.defaultThinking != "" {
		s.thinking.Set(a.defaultThinking)
	}
	a.byID[s.ID] = s
	a.all = append(a.all, s)
	if s.backend != "acp" && !s.Target.remote() {
		a.publishSessionModelOptions(s, a.modelOptionsFor(s.WS))
	}
	a.observeSessionDraft(s)
	return s
}

// newSession starts an empty conversation in the active workspace, or in
// the one at path.
func (a *app) newSession(path string) *session {
	ws := a.activeWorkspace()
	if path != "" {
		if explicit := a.workspaceByWireKey(path); explicit != nil {
			ws = explicit
		} else if ws == nil || ws.Path != path {
			ws = a.workspaceOf(path)
		}
	}
	if ws == nil {
		// No project yet: the folder picker is the next step, not an error.
		a.toast(ui.ToastInfo, "先选一个项目", "选好文件夹就开始第一次对话。")
		a.pickNative("workspace")
		return nil
	}
	return a.newProjectSession(ws)
}

func (a *app) newProjectSession(ws *workspace) *session {
	title := "新会话"
	if ws.Chat {
		title = apptext.T("对话")
	}
	// A prewarmed pi already booted in this project: its session id comes
	// with it, so the tab that adopts it starts instantly.
	id := newSessionID()
	var warm *warmPi
	if w := a.takeWarmPi(ws); w != nil {
		id, warm = w.ID, w
	}
	s := a.blankSession(id, ws, title)
	a.ensureSessionModelOptions(s, false, false)
	s.warmPi = warm
	if warm != nil {
		a.expireHeldWarmPi(s, warm, piWarmTTL)
	}
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
	origin := "project"
	if ws.Chat {
		origin = "chat"
	}
	a.sessionCreated(s, origin)
	return s
}
