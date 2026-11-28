//go:build !js && !android && !ios

package workbench

// Feishu inbound: an application's event callback dispatches each source
// chat to an independent built-in conversation. Optional replies use the
// separately configured custom bot webhook.

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

// feishuMention matches the @-mention placeholders Feishu puts in text.
var feishuMention = regexp.MustCompile(`@_user_\d+`)

// feishuCallback is an event callback's body, schema 2.0 or the older
// shape.
type feishuCallback struct {
	Challenge string `json:"challenge"`
	Token     string `json:"token"`
	Type      string `json:"type"`
	Text      string `json:"text"`
	Header    struct {
		EventType string `json:"event_type"`
		Token     string `json:"token"`
	} `json:"header"`
	Event struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		ChatID    string `json:"open_chat_id"`
		MessageID string `json:"open_message_id"`
		Sender    struct {
			Type string `json:"sender_type"`
		} `json:"sender"`
		Message struct {
			ID      string `json:"message_id"`
			ChatID  string `json:"chat_id"`
			Type    string `json:"message_type"`
			Content string `json:"content"`
		} `json:"message"`
	} `json:"event"`
	chatID, messageID string
}

// decodeFeishuCallback accepts message events from people, never bot echoes.
func decodeFeishuCallback(raw []byte) (feishuCallback, error) {
	var cb feishuCallback
	if json.Unmarshal(raw, &cb) != nil {
		return cb, fmt.Errorf("不是飞书回调")
	}
	cb.Challenge = strings.TrimSpace(cb.Challenge)
	cb.Token = strings.TrimSpace(firstNonEmpty(cb.Header.Token, cb.Token))
	text := cb.Text
	cb.Text = ""
	if cb.Header.EventType != "" && cb.Header.EventType != "im.message.receive_v1" {
		return cb, nil
	}
	if cb.Event.Sender.Type != "" && cb.Event.Sender.Type != "user" {
		return cb, nil
	}
	switch {
	case cb.Event.Message.Type == "text" && cb.Event.Message.Content != "":
		var content struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(cb.Event.Message.Content), &content) != nil {
			return cb, fmt.Errorf("不是飞书回调")
		}
		cb.Text = content.Text
		cb.chatID, cb.messageID = cb.Event.Message.ChatID, cb.Event.Message.ID
	case cb.Event.Type == "message":
		cb.Text = cb.Event.Text
		cb.chatID, cb.messageID = cb.Event.ChatID, cb.Event.MessageID
	case cb.Type == "message":
		cb.Text = text
	}
	cb.Text = strings.TrimSpace(feishuMention.ReplaceAllString(cb.Text, ""))
	return cb, nil
}

// parseFeishuCallback reads the challenge, verification token and message text.
func parseFeishuCallback(raw []byte) (challenge, token, text string, err error) {
	cb, err := decodeFeishuCallback(raw)
	return cb.Challenge, cb.Token, cb.Text, err
}

// handleFeishu receives Feishu's event callback. It answers the URL
// challenge, and dispatches each source chat to its own built-in conversation.
func (h *remoteHost) handleFeishu(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	h.app.st.mu.Lock()
	enabled, want := h.app.st.c.FeishuInbound, strings.TrimSpace(h.app.st.c.FeishuVerifyToken)
	h.app.st.mu.Unlock()
	if !enabled {
		writeRemoteJSON(w, http.StatusForbidden, map[string]string{"error": "没有开启接收群消息"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "读取请求失败"})
		return
	}
	if len(raw) > 1<<20 {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	cb, err := decodeFeishuCallback(raw)
	if err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if want == "" || subtle.ConstantTimeCompare([]byte(cb.Token), []byte(want)) != 1 {
		writeRemoteJSON(w, http.StatusUnauthorized, map[string]string{"error": "验证 Token 不匹配"})
		return
	}
	if cb.Challenge != "" {
		writeRemoteJSON(w, http.StatusOK, map[string]string{"challenge": cb.Challenge})
		return
	}
	if cb.Text != "" {
		if cb.chatID == "" || cb.messageID == "" {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "不是飞书回调"})
			return
		}
		if h.rememberFeishuMessage(cb.messageID) {
			h.feishuPrompt(cb.chatID, cb.Text)
		}
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"code": 0})
}

func (h *remoteHost) rememberFeishuMessage(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.feishuSeen[id] {
		return false
	}
	if h.feishuSeen == nil {
		h.feishuSeen = map[string]bool{}
	}
	h.feishuSeen[id] = true
	h.feishuOrder = append(h.feishuOrder, id)
	if len(h.feishuOrder) > 256 {
		delete(h.feishuSeen, h.feishuOrder[0])
		h.feishuOrder = h.feishuOrder[1:]
	}
	return true
}

// feishuSession keeps incoming messages out of the project currently on screen.
func (h *remoteHost) feishuSession(chatID string) *session {
	a := h.app
	if s := a.byID[h.feishuSessions[chatID]]; s != nil && !s.External && !s.deleting {
		return s
	}
	s := a.openChat()
	if s != nil {
		if h.feishuSessions == nil {
			h.feishuSessions = map[string]string{}
		}
		h.feishuSessions[chatID] = s.ID
	}
	return s
}

// feishuPrompt starts a turn only when the source chat's session is available.
func (h *remoteHost) feishuPrompt(chatID, text string) {
	a := h.app
	a.cx.Post(func() {
		if !a.cfg.FeishuInbound {
			return
		}
		s := h.feishuSession(chatID)
		if s == nil {
			return
		}
		if ws := a.workspaceFor(s.Target, s.WS); ws == nil || !a.projectTrusted(ws) {
			a.toast(ui.ToastWarning, "飞书消息被信任拦截", "先在应用里信任这个项目。")
			return
		}
		if s.busyNow() || a.composerBlocked(s) {
			a.toast(ui.ToastWarning, "飞书", s.title.GetUntracked()+" · "+apptext.T("运行中"))
			return
		}
		a.feishuMu.Lock()
		if a.feishuPending == nil {
			a.feishuPending = map[string]bool{}
		}
		a.feishuPending[s.ID] = true
		a.feishuMu.Unlock()
		a.submit(s, text, nil)
	})
}

// onFeishuTurn posts the answer of a Feishu-started turn back to the
// group, when that is on.
func (a *app) onFeishuTurn(ev appEvent) {
	s := ev.Session
	if s == nil {
		return
	}
	a.feishuMu.Lock()
	pending := a.feishuPending[s.ID]
	if pending {
		delete(a.feishuPending, s.ID)
	}
	a.feishuMu.Unlock()
	if !pending || !a.cfg.FeishuReply {
		return
	}
	webhook := strings.TrimSpace(a.cfg.FeishuWebhook)
	if webhook == "" {
		return
	}
	status := "已完成"
	if ev.Data["status"] != "completed" {
		status = "没有完成"
	}
	text := s.title.GetUntracked() + "\n" + status
	if answer := strings.TrimSpace(ev.Data["answer"]); answer != "" {
		text += "\n" + viewkit.FirstLine(answer, 1500)
	}
	a.sendFeishu(webhook, a.cfg.FeishuSecret, text)
}
