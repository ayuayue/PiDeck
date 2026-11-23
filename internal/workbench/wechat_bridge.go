//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
)

func (a *app) stopWechat() {
	h := a.wechat
	h.runSeq++
	if h.runCancel != nil {
		h.runCancel()
		h.runCancel = nil
	}
	h.runContext = nil
	h.pending = nil
}

func (a *app) startWechat() {
	a.stopWechat()
	h := a.wechat
	c := h.connection
	if !a.cfg.WeChatEnabled || c.Token == "" || c.Owner == "" || c.Session == "" {
		h.status.Set(apptext.T("先登录微信并绑定会话。"))
		return
	}
	ctx, cancel := context.WithCancel(h.lifetime)
	h.runContext = ctx
	h.runCancel = cancel
	seq := h.runSeq
	h.status.Set(apptext.T("微信已连接，仅接收登录账号的私聊。"))
	go func() {
		client := wechatClient{base: c.Base, token: c.Token}
		if err := client.request(ctx, http.MethodPost, "/ilink/bot/msg/notifystart", map[string]any{"base_info": wechatInfo()}, nil, 15*time.Second); err != nil {
			a.cx.Post(func() {
				if h.runSeq == seq {
					h.status.Set(err.Error())
				}
			})
		}
		failures := 0
		for ctx.Err() == nil {
			updates, err := client.updates(ctx, c.Cursor)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				a.cx.Post(func() {
					if h.runSeq == seq {
						h.status.Set(err.Error())
					}
				})
				if errors.Is(err, errWechatExpired) {
					return
				} // No automatic retry after -14.
				failures++
				delay := 2 * time.Second
				if failures >= 3 {
					delay = 30 * time.Second
				}
				if !wechatWait(ctx, delay) {
					return
				}
				continue
			}
			failures = 0
			ack := make(chan struct{})
			a.cx.Post(func() {
				defer close(ack)
				if h.runSeq != seq {
					return
				}
				previousSeen := slices.Clone(h.connection.Seen)
				previousCursor := h.connection.Cursor
				for _, m := range updates.Messages {
					a.receiveWechat(client, m)
				}
				if updates.Cursor != "" {
					h.connection.Cursor = updates.Cursor
				}
				if previousCursor != h.connection.Cursor || !slices.Equal(previousSeen, h.connection.Seen) {
					a.saveWechat()
				}
			})
			select {
			case <-ctx.Done():
				return
			case <-ack:
			}
			if updates.Cursor != "" {
				c.Cursor = updates.Cursor
			}
			if !wechatWait(ctx, 250*time.Millisecond) {
				return
			}
		}
	}()
}

func (a *app) receiveWechat(client wechatClient, m wechatMessage) {
	h := a.wechat
	if m.Type != 1 || m.Group != "" || m.From != h.connection.Owner || m.Context == "" {
		return
	}
	id := strconv.FormatInt(m.ID, 10)
	if m.ID == 0 || slices.Contains(h.connection.Seen, id) {
		return
	}
	h.connection.Seen = append(h.connection.Seen, id)
	if len(h.connection.Seen) > 256 {
		h.connection.Seen = h.connection.Seen[len(h.connection.Seen)-256:]
	}
	text := wechatText(m)
	if text == "" {
		a.rejectWechat(client, m, apptext.T("目前仅支持文字或已转写的语音消息。"))
		return
	}
	s := a.byID[h.connection.Session]
	if s == nil || s.External || s.deleting {
		a.rejectWechat(client, m, apptext.T("绑定的会话已不可用，请重新绑定。"))
		return
	}
	ws := a.workspaceFor(s.Target, s.WS)
	if ws == nil || !a.projectTrusted(ws) {
		a.rejectWechat(client, m, apptext.T("请先在应用中信任绑定会话的项目。"))
		return
	}
	if s.busyNow() || h.pending != nil {
		a.rejectWechat(client, m, apptext.T("会话正在运行，微信消息未提交；请稍后重发。"))
		return
	}
	h.pending = &wechatReply{session: s.ID, to: m.From, token: m.Context}
	h.status.Set(apptext.T("已收到微信消息，正在处理。"))
	a.submit(s, text, nil)
}

func (a *app) rejectWechat(client wechatClient, m wechatMessage, reason string) {
	h := a.wechat
	h.status.Set(reason)
	if h.runContext == nil || !a.cfg.WeChatEnabled {
		return
	}
	ctx, cancel := context.WithTimeout(h.runContext, 15*time.Second)
	seq := h.runSeq
	go func() {
		defer cancel()
		if err := client.send(ctx, m.From, m.Context, reason); err != nil {
			a.cx.Post(func() {
				if h.runSeq == seq {
					h.status.Set(err.Error())
				}
			})
		}
	}()
}

func (a *app) onWechatTurn(ev appEvent) {
	h := a.wechat
	if h == nil || h.pending == nil || ev.Session == nil || h.pending.session != ev.Session.ID {
		return
	}
	reply := *h.pending
	h.pending = nil
	if !a.cfg.WeChatEnabled || h.runCancel == nil {
		return
	}
	text := strings.TrimSpace(ev.Data["answer"])
	if text == "" {
		text = apptext.T("会话已结束一轮。")
	}
	if len([]rune(text)) > 3500 {
		text = string([]rune(text)[:3500]) + "…"
	}
	client := wechatClient{base: h.connection.Base, token: h.connection.Token}
	seq := h.runSeq
	ctx, cancel := context.WithTimeout(h.runContext, 20*time.Second)
	go func() {
		defer cancel()
		err := client.send(ctx, reply.to, reply.token, text)
		a.cx.Post(func() {
			if h.runSeq != seq {
				return
			}
			if err != nil {
				h.status.Set(err.Error())
			} else {
				h.status.Set(apptext.T("回答已发送到微信。"))
			}
		})
	}()
}
