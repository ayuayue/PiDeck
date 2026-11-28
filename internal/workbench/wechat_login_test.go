//go:build !js && !android && !ios

package workbench

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type wechatLoginTransport func(*http.Request) (*http.Response, error)

func (fn wechatLoginTransport) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestWechatQRCodeLogin(t *testing.T) {
	for _, tc := range []struct {
		name, status, want string
		linked             bool
	}{
		{"confirmed", `{"status":"confirmed","bot_token":"fixture","ilink_user_id":"owner","baseurl":"https://ilinkai.weixin.qq.com"}`, "已登录，请绑定一个已信任的会话并开启接收。", true},
		{"expired", `{"status":"expired"}`, "二维码或验证码已失效，请重新登录。", false},
		{"untrusted-host", `{"status":"confirmed","bot_token":"fixture","ilink_user_id":"owner","baseurl":"https://example.invalid"}`, "invalid iLink login confirmation", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := appHTTPLongClient
			var polls atomic.Int32
			appHTTPLongClient = &http.Client{Transport: wechatLoginTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "ilinkai.weixin.qq.com" {
					t.Errorf("unexpected host %s", r.URL.Host)
				}
				if r.Header.Get("iLink-App-Id") != "bot" || r.Header.Get("iLink-App-ClientVersion") != "196608" {
					t.Error("missing iLink application headers")
				}
				body := tc.status
				switch r.URL.Path {
				case "/ilink/bot/get_bot_qrcode":
					if r.Method != http.MethodPost || r.URL.Query().Get("bot_type") != "3" {
						t.Error("invalid QR request")
					}
					body = `{"qrcode":"fixture-code","qrcode_img_content":"https://example.invalid/fixture"}`
				case "/ilink/bot/get_qrcode_status":
					polls.Add(1)
					if r.Method != http.MethodGet || r.URL.Query().Get("qrcode") != "fixture-code" || r.Header.Get("AuthorizationType") != "" || r.Header.Get("X-WECHAT-UIN") != "" {
						t.Error("invalid QR status request")
					}
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}
			t.Cleanup(func() { appHTTPLongClient = previous })
			a, screen, _ := startSessionLifecycleApp(t)
			t.Cleanup(wechatWrites.Wait)
			screen.WaitUntil(5*time.Second, func() bool { return a.wechat.ready.GetUntracked() })
			onNativeUI(t, screen, a, a.loginWechat)
			screen.WaitUntil(5*time.Second, func() bool { return a.wechat.status.GetUntracked() == tc.want })
			if a.wechat.linked.GetUntracked() != tc.linked || polls.Load() != 1 {
				t.Fatalf("login linked=%v polls=%d", a.wechat.linked.GetUntracked(), polls.Load())
			}
			if tc.linked {
				wechatWrites.Wait()
				stored := readWechat(filepath.Join(a.st.dir, "wechat", "connection.yaml"))
				if stored.Token != "fixture" || stored.Owner != "owner" || stored.Session != "" {
					t.Fatalf("login state was not saved correctly: owner=%q session=%q", stored.Owner, stored.Session)
				}
			}
		})
	}
}
