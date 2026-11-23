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

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
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
	out.Name, out.Version, out.Host = "PiDeck V2", pideckVersion, host
	ok := a.withUI(func() {
		for _, ws := range a.workspaces.GetUntracked() {
			a.scanProject(ws)
			pinned, rest := a.projectSessions(ws)
			project := remotewire.Project{Path: projectWireKey(ws), Name: ws.label()}
			if ws.Target.remote() {
				project.Target, project.Root = ws.Target.shortLabel(), ws.Path
			}
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
func (a *app) remoteTranscript(id string, before int) (remotewire.Transcript, error) {
	var out remotewire.Transcript
	var title, file string
	var t target
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
		t = s.Target
		running = s.busyNow()
		ask = remoteAskOf(s)
		live, liveThinking = s.streamText.GetUntracked(), s.streamThinking.GetUntracked()
		if loaded {
			turns = cloneTranscriptTurns(s.turns.GetUntracked())
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
		var history []turn
		var err error
		if t.remote() {
			var msgs []piMessage
			msgs, err = targetHistoryMessages(t, file)
			history = turnsFromMessages(msgs)
		} else {
			history, err = readSessionTurns(file)
		}
		if err != nil {
			out.Error = "读取会话失败：" + err.Error()
			return out, nil
		}
		turns = history
	}
	out.Messages, out.Before, out.Truncated = remoteMessages(turns, before)
	out.Running = running
	// The live buffers are what pi is saying right now; the turns only
	// carry what it has finished.
	if running && before <= 0 {
		current := max(0, len(turns)-1)
		if thinking := strings.TrimSpace(liveThinking); thinking != "" {
			out.Messages = append(out.Messages, remotewire.Message{Role: "thinking", Text: thinking, Turn: current})
		}
		if text := strings.TrimSpace(live); text != "" {
			last := len(out.Messages) > 0 && out.Messages[len(out.Messages)-1].Role == "assistant" &&
				out.Messages[len(out.Messages)-1].Text == text
			if !last {
				out.Messages = append(out.Messages, remotewire.Message{Role: "assistant", Text: text, Turn: current})
			}
		}
	}
	return out, nil
}

// readSessionTurns reads the messages of a pi session file, from the parse
// the desktop keeps, so a phone polling a long session does not read it
// again on every request.
func readSessionTurns(path string) ([]turn, error) {
	entry, err := sessionFileHistory(path)
	if err != nil {
		return nil, err
	}
	return entry.phone(), nil
}

// remotePageTurns is how many turns one reply carries: enough to read,
// few enough that the phone draws the page at once. Older turns come with
// ?before=, so nothing is lost.
const remotePageTurns = 20

// remotePageBudget keeps a page under the client's read limit even when
// its turns are huge: the page then carries fewer turns, never less text.
const remotePageBudget = 1_500_000

// remoteMessageRunes guards a page made of one enormous turn: that line
// cannot travel whole, so it is sent by its head and the client says so.
// Anything that fits a page is sent untouched.
const remoteMessageRunes = 200_000

// remoteMessages flattens one page of turns into the phone's chat lines:
// the turns ending at before, at most remotePageTurns of them. It returns
// where the page starts, which is the client's cursor for the turns
// before it, and whether a single line had to be cut.
func remoteMessages(turns []turn, before int) ([]remotewire.Message, int, bool) {
	if before <= 0 || before > len(turns) {
		before = len(turns)
	}
	start := before - remotePageTurns
	if start < 0 {
		start = 0
	}
	// A page of enormous turns keeps its newest turn and gives up the
	// older ones: the client asks for those next.
	for start < before-1 && turnTextSize(turns[start:before]) > remotePageBudget {
		start++
	}
	// Only a page that is still over the budget after that — a single huge
	// turn — has its lines cut.
	clip := 0
	if turnTextSize(turns[start:before]) > remotePageBudget {
		clip = remoteMessageRunes
	}
	truncated := false
	var out []remotewire.Message
	for i := start; i < before; i++ {
		t := turns[i]
		add := func(role, text string) {
			text = strings.TrimSpace(text)
			if text == "" {
				return
			}
			if clip > 0 {
				if r := []rune(text); len(r) > clip {
					text = string(r[:clip]) + "…"
					truncated = true
				}
			}
			out = append(out, remotewire.Message{Role: role, Text: text, Turn: i})
		}
		add("user", t.Prompt)
		remainingImages := 24
		addImages := func(step, tool int, images []remotewire.Image) {
			for index, img := range images[:min(len(images), remainingImages)] {
				ref := ""
				if len(img.Data) > 0 && len(img.Data) <= remotewire.MaxTranscriptImageBytes {
					ref = transcriptImageRef(i, step, tool, index, t.Start)
				}
				out = append(out, remotewire.Message{Role: "image", Text: "［图片］", Turn: i, Image: ref})
				remainingImages--
			}
		}
		addImages(-1, -1, t.Images)
		for stepIndex, step := range t.Steps {
			add("note", step.Note)
			add("thinking", step.Thinking)
			for toolIndex, tool := range step.Tools {
				add("tool", strings.TrimSpace(tool.Action+" "+tool.Detail))
				addImages(stepIndex, toolIndex, tool.Images)
			}
			add("assistant", step.Text)
		}
		if t.Final != "" {
			final := strings.TrimSpace(t.Final)
			last := len(out) > 0 && out[len(out)-1].Role == "assistant" && out[len(out)-1].Text == final
			if !last {
				add("assistant", t.Final)
			}
		}
		add("error", t.Err)
	}
	return out, start, truncated
}

// turnTextSize is how much text a page of turns carries.
func turnTextSize(turns []turn) int {
	size := 0
	for _, t := range turns {
		size += len(t.Prompt) + len(t.Final) + len(t.Err)
		for _, step := range t.Steps {
			size += len(step.Note) + len(step.Thinking) + len(step.Text)
			for _, tool := range step.Tools {
				size += len(tool.Action) + len(tool.Detail)
			}
		}
	}
	return size
}
