//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"example.com/pideck-lite/internal/apptext"
	qrcode "github.com/skip2/go-qrcode"
)

func (a *app) loginWechat() {
	h := a.wechat
	if !h.ready.GetUntracked() {
		return
	}
	if h.loginCancel != nil {
		h.loginCancel()
	}
	h.loginSeq++
	seq := h.loginSeq
	ctx, cancel := context.WithTimeout(h.lifetime, 5*time.Minute)
	h.loginCancel = cancel
	h.codes = make(chan string, 1)
	codes := h.codes
	h.status.Set(apptext.T("正在获取微信二维码…"))
	h.qr.Set(nil)
	h.needCode.Set(false)
	go func() {
		defer cancel()
		client := wechatClient{base: wechatBase}
		post := func(fn func()) {
			a.cx.Post(func() {
				if h.loginSeq == seq {
					fn()
				}
			})
		}
		fail := func(err error) { post(func() { h.status.Set(err.Error()); h.needCode.Set(false); h.qr.Set(nil) }) }
		var qr wechatQR
		if err := client.request(ctx, http.MethodPost, "/ilink/bot/get_bot_qrcode?bot_type=3", map[string]any{"local_token_list": []string{}}, &qr, 15*time.Second); err != nil {
			fail(err)
			return
		}
		if qr.QRCode == "" || len(qr.QRCode) > 4096 || qr.Content == "" || len(qr.Content) > 8192 {
			fail(errors.New("invalid iLink QR response"))
			return
		}
		png, err := qrcode.Encode(qr.Content, qrcode.Medium, 320)
		if err != nil {
			fail(err)
			return
		}
		post(func() { h.qr.Set(png); h.status.Set(apptext.T("用微信扫码并确认登录。")) })
		code := ""
		for ctx.Err() == nil {
			path := "/ilink/bot/get_qrcode_status?qrcode=" + url.QueryEscape(qr.QRCode)
			if code != "" {
				path += "&verify_code=" + url.QueryEscape(code)
			}
			var status wechatQR
			err := client.request(ctx, http.MethodGet, path, nil, &status, 45*time.Second)
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				continue
			}
			if err != nil {
				fail(err)
				return
			}
			switch status.Status {
			case "confirmed":
				base, err := trustedWechatBase(firstNonEmpty(status.Base, client.base))
				if err != nil || status.Token == "" || len(status.Token) > 8192 || status.Owner == "" || len(status.Owner) > 512 {
					fail(errors.New("invalid iLink login confirmation"))
					return
				}
				post(func() {
					a.stopWechat()
					h.connection = wechatConnection{Version: 1, Base: base, Token: status.Token, Owner: status.Owner}
					a.saveWechat()
					h.linked.Set(true)
					h.qr.Set(nil)
					h.needCode.Set(false)
					h.status.Set(apptext.T("已登录，请绑定一个已信任的会话并开启接收。"))
				})
				return
			case "expired", "verify_code_blocked":
				fail(errors.New(apptext.T("二维码或验证码已失效，请重新登录。")))
				return
			case "need_verifycode", "confirmed_but_need_verifycode":
				post(func() { h.needCode.Set(true); h.status.Set(apptext.T("请输入微信显示的验证码。")) })
				select {
				case code = <-codes:
					post(func() { h.needCode.Set(false) })
				case <-ctx.Done():
					fail(ctx.Err())
					return
				}
			case "binded_redirect":
				post(func() {
					h.qr.Set(nil)
					h.needCode.Set(false)
					h.status.Set(apptext.T("此微信已连接过，请使用原连接或重新生成二维码。"))
				})
				return
			case "scaned_but_redirect":
				if status.Redirect == "" {
					break
				}
				base, err := trustedWechatBase(status.Redirect)
				if err != nil {
					fail(err)
					return
				}
				client.base = base
			case "scaned":
				code = ""
				post(func() { h.status.Set(apptext.T("已扫码，等待微信确认。")) })
			case "wait":
			default:
				fail(errors.New("unknown iLink QR status"))
				return
			}
			if !wechatWait(ctx, 2*time.Second) {
				break
			}
		}
		fail(ctx.Err())
	}()
}
