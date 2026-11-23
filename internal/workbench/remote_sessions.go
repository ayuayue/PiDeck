//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
)

// handleSessionAction runs one operation on a session.
func (h *remoteHost) handleSessionAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	parts := strings.SplitN(rest, "/", 2)
	id, err := url.PathUnescape(parts[0])
	if err != nil || id == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少会话 ID"})
		return
	}
	action := ""
	if len(parts) == 2 {
		action = strings.Trim(parts[1], "/")
	}
	switch action {
	case "prompt":
		h.sessionPrompt(w, r, id)
	case "stop":
		h.sessionStop(w, id)
	case "rename":
		h.sessionRename(w, r, id)
	case "pin":
		h.sessionPin(w, r, id)
	case "model":
		h.sessionModel(w, r, id)
	case "thinking":
		h.sessionThinking(w, r, id)
	case "delete":
		h.sessionDelete(w, r, id)
	case "answer":
		h.sessionAnswer(w, r, id)
	case "mode":
		h.sessionMode(w, r, id)
	case "backend":
		h.sessionBackend(w, r, id)
	case "tools":
		h.sessionTool(w, r, id)
	case "image":
		h.sessionImage(w, r, id)
	default:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个操作"})
	}
}

// sessionPrompt sends one message into a session, starting pi when the
// session was never opened on the desktop.
func (h *remoteHost) sessionPrompt(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Text   string `json:"text"`
		Images []struct {
			Mime string `json:"mime"`
			Data string `json:"data"`
		} `json:"images"`
	}
	if err := decodeRemoteBodyLimit(r, &body, 48<<20); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	text := strings.TrimSpace(body.Text)
	switch {
	case text == "" && len(body.Images) == 0:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "消息不能为空"})
		return
	case len([]rune(text)) > 20000:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "消息太长了"})
		return
	case len(body.Images) > 4:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "一次最多 4 张图片"})
		return
	}
	var images []remotewire.Image
	for _, raw := range body.Images {
		data, err := base64.StdEncoding.DecodeString(raw.Data)
		if err != nil || len(data) == 0 {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "图片数据不对"})
			return
		}
		if len(data) > 6<<20 {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "单张图片不能超过 6 MB"})
			return
		}
		mime := strings.TrimSpace(raw.Mime)
		if mime == "" {
			mime = "image/png"
		}
		images = append(images, remotewire.Image{Data: data, MimeType: mime, Name: "phone"})
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		ws := h.app.workspaceFor(s.Target, s.WS)
		if s.deleting {
			failure = errors.New(apptext.T("正在删除会话…"))
			return
		}
		if (s.Target.remote() && ws == nil) || !h.app.projectTrusted(ws) {
			failure = errors.New(apptext.T("这个项目还没有在电脑上被信任"))
			return
		}
		// Image mode draws the words instead of prompting pi, as the
		// desktop's composer does.
		if modeOn(s, modeImage) {
			if text != "" {
				h.app.generateComposerImage(s, text)
			}
			return
		}
		// A message for a turn that is still running steers it, as the
		// desktop's composer does.
		if s.busyNow() {
			h.app.steer(s, text, images)
			return
		}
		h.app.submit(s, text, images)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}

// sessionStop aborts the running turn.
func (h *remoteHost) sessionStop(w http.ResponseWriter, id string) {
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		if s.busyNow() {
			h.app.stop(s)
		}
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true})
}
