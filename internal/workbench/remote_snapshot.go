//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"errors"
	"os"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
)

// remoteAskOf is the question a session is waiting on, if any.
func remoteAskOf(s *session) *remotewire.Ask {
	ask := s.ask.GetUntracked()
	if ask == nil {
		return nil
	}
	if ask.Method == remotewire.AskMethodBatch {
		// The phone has no card for several questions: it can only let the
		// request go, and the desktop answers it.
		title := apptext.T("批量提问")
		if len(ask.Questions) > 0 {
			title += " · " + viewkit.FirstLine(ask.Questions[0].Question, 60)
		}
		return &remotewire.Ask{Method: ask.Method, Title: title,
			Message: apptext.T("共 %d 题，请到桌面端回答。", len(ask.Questions))}
	}
	return &remotewire.Ask{Method: ask.Method, Title: ask.Title, Message: ask.Message,
		Options: append([]string(nil), ask.Options...)}
}

// remoteSnapshot reads the projects and sessions on the UI thread.
func (a *app) remoteSnapshot() (remotewire.Snapshot, error) {
	var out remotewire.Snapshot
	host, _ := os.Hostname()
	out.Name, out.Version, out.Host = "PiDeck Lite", pideckVersion, host
	ok := a.withUI(func() {
		for _, ws := range a.workspaces.GetUntracked() {
			if ws.Target.remote() {
				continue
			}
			a.scanProject(ws)
			pinned, rest := a.projectSessions(ws)
			project := remotewire.Project{Path: ws.Path, Name: ws.label()}
			for _, s := range append(pinned, rest...) {
				if s == nil {
					continue
				}
				stats := s.stats.Get()
				usage := s.usage.Get()
				project.Sessions = append(project.Sessions, remotewire.Session{
					ID: s.ID, Title: s.title.Get(), Status: remoteStatus(s.status.Get()),
					Updated: s.updated.Get().UnixMilli(), External: s.External,
					Pinned: a.isPinned(s.ID), Running: s.busyNow(), Ask: remoteAskOf(s),
					Mode:   remoteModeOf(s),
					Tokens: usage.Total, Context: stats.ContextTokens, ContextWindow: stats.ContextWindow, Cost: usage.Cost,
				})
			}
			out.Projects = append(out.Projects, project)
		}
	})
	if !ok {
		return out, errors.New("界面正忙，请稍后再试")
	}
	return out, nil
}

// remoteModeOf is the session's mode as the phone names it: empty for a
// normal prompt.
func remoteModeOf(s *session) string {
	switch {
	case modeOn(s, modePlan):
		return modePlan
	case modeOn(s, modeGoal):
		return modeGoal
	case modeOn(s, modeImage):
		return modeImage
	}
	return ""
}

func remoteStatus(s sessionStatus) string {
	switch s {
	case statusStarting:
		return "starting"
	case statusRunning:
		return "running"
	case statusWaiting:
		return "waiting"
	case statusFailed:
		return "failed"
	}
	return "idle"
}

// remoteTranscript reads one session's history, from memory when it is
// open and from its file otherwise.
func (a *app) remoteTranscript(id string) (remotewire.Transcript, error) {
	var out remotewire.Transcript
	var title, file string
	var turns []turn
	var found, loaded, running bool
	var live, liveThinking string
	var ask *remotewire.Ask
	ok := a.withUI(func() {
		s := a.byID[id]
		if s == nil {
			return
		}
		found, title, file, loaded = true, s.title.Get(), s.File, s.loaded.GetUntracked()
		running = s.busyNow()
		ask = remoteAskOf(s)
		live, liveThinking = s.streamText.GetUntracked(), s.streamThinking.GetUntracked()
		if loaded {
			turns = s.turns.GetUntracked()
		}
	})
	if !ok {
		return out, errors.New("界面正忙，请稍后再试")
	}
	if !found {
		return out, errors.New("找不到这个会话")
	}
	out.ID, out.Title, out.Ask = id, title, ask
	if !loaded {
		if file == "" {
			// A session that never ran has no file yet; that is empty, not
			// an error.
			return out, nil
		}
		history, err := readSessionTurns(file)
		if err != nil {
			out.Error = "读取会话失败：" + err.Error()
			return out, nil
		}
		turns = history
	}
	out.Messages = remoteMessages(turns)
	out.Running = running
	// The live buffers are what pi is saying right now; the turns only
	// carry what it has finished.
	if running {
		if thinking := strings.TrimSpace(liveThinking); thinking != "" {
			out.Messages = append(out.Messages, remotewire.Message{Role: "thinking", Text: thinking})
		}
		if text := strings.TrimSpace(live); text != "" {
			last := len(out.Messages) > 0 && out.Messages[len(out.Messages)-1].Role == "assistant" &&
				out.Messages[len(out.Messages)-1].Text == text
			if !last {
				out.Messages = append(out.Messages, remotewire.Message{Role: "assistant", Text: text})
			}
		}
	}
	return out, nil
}

// readSessionTurns reads the messages of a pi session file, from the parse
// the desktop keeps, so a phone polling a long session does not read it
// again on every request.
func readSessionTurns(path string) ([]turn, error) {
	msgs, err := sessionFileMessages(path)
	if err != nil {
		return nil, err
	}
	if len(msgs) > 4000 {
		msgs = msgs[len(msgs)-4000:]
	}
	return turnsFromMessages(msgs), nil
}

// remoteMessages flattens turns into the phone's chat lines: what the user
// asked, what pi thought and said, and the tools it named; output stays on
// the desktop.
func remoteMessages(turns []turn) []remotewire.Message {
	var out []remotewire.Message
	var size int
	add := func(role, text string) {
		text = strings.TrimSpace(text)
		if text == "" || size > 240_000 {
			return
		}
		if r := []rune(text); len(r) > 12_000 {
			text = string(r[:12_000]) + "…"
		}
		out = append(out, remotewire.Message{Role: role, Text: text})
		size += len(text)
	}
	for _, t := range turns {
		prompt := t.Prompt
		if len(t.Images) > 0 {
			prompt = strings.TrimSpace(prompt + " ［图片］")
		}
		add("user", prompt)
		for _, step := range t.Steps {
			add("note", step.Note)
			add("thinking", step.Thinking)
			for _, tool := range step.Tools {
				line := strings.TrimSpace(tool.Action + " " + tool.Detail)
				add("tool", line)
			}
			add("assistant", step.Text)
		}
		if t.Final != "" {
			duplicate := len(out) > 0 && out[len(out)-1].Role == "assistant" && out[len(out)-1].Text == strings.TrimSpace(t.Final)
			if !duplicate {
				add("assistant", t.Final)
			}
		}
		add("error", t.Err)
	}
	return out
}
