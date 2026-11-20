package workbench

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestWechatTransportAndExpiredSession(t *testing.T) {
	expired := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("AuthorizationType") != "ilink_bot_token" || r.Header.Get("X-WECHAT-UIN") == "" {
			t.Error("missing iLink authentication")
		}
		if expired {
			w.Write([]byte(`{"ret":-1,"errcode":-14}`))
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request JSON")
		}
		if body["base_info"] == nil {
			t.Error("missing base_info")
		}
		switch r.URL.Path {
		case "/ilink/bot/getupdates":
			if body["get_updates_buf"] != "previous" {
				t.Error("cursor not replayed")
			}
			w.Write([]byte(`{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":7,"from_user_id":"owner","message_type":1,"context_token":"reply-token","item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}`))
		case "/ilink/bot/sendmessage":
			m, _ := body["msg"].(map[string]any)
			if m["to_user_id"] != "owner" || m["context_token"] != "reply-token" || m["message_type"] != float64(2) {
				t.Errorf("incorrect reply envelope %+v", m)
			}
			w.Write([]byte(`{"ret":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := wechatClient{base: srv.URL, token: "fixture"}
	updates, err := c.updates(t.Context(), "previous")
	if err != nil || len(updates.Messages) != 1 || updates.Cursor != "next" || wechatText(updates.Messages[0]) != "hello" {
		t.Fatalf("updates=%+v err=%v", updates, err)
	}
	if err := c.send(t.Context(), "owner", "reply-token", "answer"); err != nil {
		t.Fatal(err)
	}
	if err := c.send(t.Context(), "owner", "", "answer"); err == nil {
		t.Fatal("accepted reply without context token")
	}
	expired = true
	if _, err := c.updates(t.Context(), "previous"); !errors.Is(err, errWechatExpired) {
		t.Fatalf("expired session = %v", err)
	}
	for _, base := range []string{"http://ilinkai.weixin.qq.com", "https://weixin.qq.com.evil", "https://u@ilinkai.weixin.qq.com", "https://ilinkai.weixin.qq.com:8443", "https://ilinkai.weixin.qq.com/other"} {
		if _, err := trustedWechatBase(base); err == nil {
			t.Errorf("trusted %q", base)
		}
	}
}

func TestWechatCredentialFileValidationAndInboundOwnership(t *testing.T) {
	file := filepath.Join(t.TempDir(), "connection.yaml")
	if err := os.WriteFile(file, []byte("version: 1\nbase: https://evil.example\ntoken: secret\nowner: owner\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readWechat(file); got.Token != "" {
		t.Fatal("accepted a credential destination outside WeChat")
	}
	if err := os.WriteFile(file, []byte("invalid: ["), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readWechat(file); got.Token != "" || got.Version != 1 {
		t.Fatalf("malformed fallback %+v", got)
	}
	h := &wechatHost{connection: wechatConnection{Owner: "owner"}}
	a := &app{wechat: h}
	// Rejected senders and groups cannot reach any app state or agent.
	for _, m := range []wechatMessage{{ID: 1, From: "stranger", Type: 1, Context: "t"}, {ID: 2, From: "owner", Group: "group", Type: 1, Context: "t"}, {ID: 3, From: "owner", Type: 2, Context: "t"}, {ID: 4, From: "owner", Type: 1}} {
		a.receiveWechat(wechatClient{}, m)
	}
	if len(h.connection.Seen) != 0 || h.pending != nil {
		t.Fatal("untrusted inbound message reached session handling")
	}
}
