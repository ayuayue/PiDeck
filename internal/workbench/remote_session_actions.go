//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
)

// sessionAnswer answers the question a session is waiting on, so a turn
// that needs approval can finish while the user is away from the desk.
func (h *remoteHost) sessionAnswer(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Confirmed *bool  `json:"confirmed"`
		Value     string `json:"value"`
		Cancelled bool   `json:"cancelled"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		ask := s.ask.GetUntracked()
		if ask == nil {
			failure = errors.New("这个会话没有等待回答")
			return
		}
		value := map[string]any{}
		switch ask.Method {
		case "confirm":
			if body.Confirmed == nil {
				failure = errors.New("缺少 confirmed")
				return
			}
			value["confirmed"] = *body.Confirmed
		case "select":
			if body.Cancelled {
				value["cancelled"] = true
				break
			}
			known := false
			for _, opt := range ask.Options {
				if opt == body.Value {
					known = true
					break
				}
			}
			if !known {
				failure = errors.New("这个选项不存在")
				return
			}
			value["value"] = body.Value
		case "input", "editor":
			if body.Cancelled {
				value["cancelled"] = true
				break
			}
			if strings.TrimSpace(body.Value) == "" {
				failure = errors.New("缺少回答内容")
				return
			}
			value["value"] = body.Value
		default:
			value["cancelled"] = true
		}
		h.app.answerAsk(s, value)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionRename sets a session's name, here and in pi.
func (h *remoteHost) sessionRename(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Title string `json:"title"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	name := strings.TrimSpace(body.Title)
	switch {
	case name == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "名字不能为空"})
		return
	case len([]rune(name)) > 80:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "名字太长了"})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		s.title.Set(name)
		if h.app.st != nil {
			h.app.st.edit(func(c *config) { c.Titles[s.ID] = name })
		}
		if s.engine != nil {
			go func(c *piClient) {
				_ = c.call(map[string]any{"type": "set_session_name", "name": name}, nil, 10*time.Second)
			}(s.engine)
		}
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true, "title": name})
}

// sessionPin pins or unpins a session in the rail.
func (h *remoteHost) sessionPin(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Pinned *bool `json:"pinned"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		want := !h.app.isPinned(id)
		if body.Pinned != nil {
			want = *body.Pinned
		}
		if h.app.isPinned(id) != want {
			h.app.togglePin(s)
		}
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionDelete removes a session and moves its file to the trash.
func (h *remoteHost) sessionDelete(w http.ResponseWriter, id string) {
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		if s.External {
			failure = errors.New("这是 pi 自己的会话，不能在手机上删除")
			return
		}
		h.app.removeSession(s)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionOptions lists the models and levels of a session, starting pi
// when it is not up yet.
func (h *remoteHost) sessionOptions(w http.ResponseWriter, id string) {
	var out remotewire.Options
	var found bool
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			return
		}
		found = true
		current := s.model.GetUntracked()
		out.Model, out.Provider, out.Thinking = current.ID, current.Provider, s.thinking.GetUntracked()
		out.Mode = remoteModeOf(s)
		out.Backend = backendOf(s)
		if out.Backend == "acp" {
			out.Backend = "acp:" + s.acpPreset
			if p := h.app.acpPresetByID(s.acpPreset); p != nil {
				out.BackendName = p.Name
			}
		} else {
			out.BackendName = "pi"
		}
		out.BackendLocked = h.app.backendLocked(s)
		out.Backends = append(out.Backends, remotewire.Backend{ID: "pi", Name: "pi", Detail: apptext.T("本机 pi 会话")})
		for _, p := range h.app.acpPresetList() {
			out.Backends = append(out.Backends, remotewire.Backend{
				ID: "acp:" + p.ID, Name: p.Name, Detail: strings.TrimSpace(p.Command + " " + strings.Join(p.Args, " ")),
			})
		}
		out.Tools = h.app.remoteDraftTools()
		for _, m := range s.models.GetUntracked() {
			out.Models = append(out.Models, remotewire.Model{ID: m.ID, Name: m.label(), Provider: m.Provider, Reasoning: m.Reasoning})
		}
		out.Levels = append([]string(nil), s.levels.GetUntracked()...)
		out.Ready = s.readySig.GetUntracked()
		if !out.Ready {
			h.app.ensureEngine(s, nil)
		}
	})
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case !found:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个会话"})
	default:
		writeRemoteJSON(w, http.StatusOK, out)
	}
}

// sessionModel switches the model of a session.
func (h *remoteHost) sessionModel(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.ID) == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少模型 ID"})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		h.app.applyModel(s, body.Provider, body.ID, false)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionThinking switches the reasoning level of a session.
func (h *remoteHost) sessionThinking(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Level string `json:"level"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	level := strings.TrimSpace(body.Level)
	if level == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少思考等级"})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		h.app.applyThinking(s, level, false)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// finishAction writes the outcome of a UI-thread action.
func (h *remoteHost) finishAction(w http.ResponseWriter, ok bool, failure error, body map[string]any) {
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case failure != nil:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": failure.Error()})
	default:
		writeRemoteJSON(w, http.StatusOK, body)
	}
}
