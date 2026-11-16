//go:build !js && !android && !ios

package main

// Feishu inbound: the group bot's event callback. Feishu posts a message
// event here, the app sends its text to the active session, and the
// answer can go back to the group.

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

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
	Event json.RawMessage `json:"event"`
}

// parseFeishuCallback reads a callback: its challenge, verification
// token, and a message's text.
func parseFeishuCallback(raw []byte) (challenge, token, text string, err error) {
	var cb feishuCallback
	if json.Unmarshal(raw, &cb) != nil {
		return "", "", "", fmt.Errorf("不是飞书回调")
	}
	challenge = strings.TrimSpace(cb.Challenge)
	token = strings.TrimSpace(cb.Header.Token)
	if token == "" {
		token = strings.TrimSpace(cb.Token)
	}
	// v1: the event's type and text sit at the top level.
	if cb.Type == "message" && cb.Text != "" {
		text = cb.Text
	}
	if len(cb.Event) > 0 {
		var ev struct {
			Type    string `json:"type"`
			Text    string `json:"text"`
			Message struct {
				ChatID      string `json:"chat_id"`
				MessageType string `json:"message_type"`
				Content     string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(cb.Event, &ev) == nil {
			switch {
			case ev.Message.MessageType == "text" && ev.Message.Content != "":
				var content struct {
					Text string `json:"text"`
				}
				if json.Unmarshal([]byte(ev.Message.Content), &content) == nil {
					text = content.Text
				}
			case ev.Type == "message" && ev.Text != "":
				text = ev.Text
			}
		}
	}
	text = strings.TrimSpace(feishuMention.ReplaceAllString(text, ""))
	return challenge, token, text, nil
}

// handleFeishu receives Feishu's event callback. It answers the URL
// challenge, and sends a message's text to the active session.
func (h *remoteHost) handleFeishu(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	cfg := h.app.cfg
	if !cfg.FeishuInbound {
		writeRemoteJSON(w, http.StatusForbidden, map[string]string{"error": "没有开启接收群消息"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "读取请求失败"})
		return
	}
	challenge, token, text, err := parseFeishuCallback(raw)
	if err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	want := strings.TrimSpace(cfg.FeishuVerifyToken)
	if want == "" || subtle.ConstantTimeCompare([]byte(token), []byte(want)) != 1 {
		writeRemoteJSON(w, http.StatusUnauthorized, map[string]string{"error": "验证 Token 不匹配"})
		return
	}
	if challenge != "" {
		writeRemoteJSON(w, http.StatusOK, map[string]string{"challenge": challenge})
		return
	}
	if text != "" {
		h.app.feishuPrompt(text)
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"code": 0})
}

// feishuPrompt sends a group message's text to the active session, or to
// a new built-in chat when none is open.
func (a *app) feishuPrompt(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	a.cx.Post(func() {
		s := a.active()
		if s == nil {
			s = a.openChat()
		}
		if s == nil {
			return
		}
		if ws := a.workspaceOf(s.WS); ws != nil && !a.projectTrusted(ws) {
			a.toast(ui.ToastWarning, "飞书消息被信任拦截", "先在应用里信任这个项目。")
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
		text += "\n" + firstLine(answer, 1500)
	}
	secret := a.cfg.FeishuSecret
	go func() { _ = sendFeishu(webhook, secret, text) }()
}
