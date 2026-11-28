//go:build !js && !android && !ios

package workbench

// Checks Feishu's inbound callback: parsing both event shapes, the URL
// challenge, the verification token, and the settings rows.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestParseFeishuCallback(t *testing.T) {
	body := `{"schema":"2.0","header":{"event_type":"im.message.receive_v1","token":"tok"},
		"event":{"message":{"chat_id":"c1","message_type":"text","content":"{\"text\":\"@_user_1 跑一下测试\"}"}}}`
	challenge, token, text, err := parseFeishuCallback([]byte(body))
	if err != nil || challenge != "" || token != "tok" || text != "跑一下测试" {
		t.Fatalf("v2 = %q, %q, %q, %v", challenge, token, text, err)
	}
	challenge, token, text, err = parseFeishuCallback([]byte(`{"challenge":"abc","token":"tok2"}`))
	if err != nil || challenge != "abc" || token != "tok2" || text != "" {
		t.Fatalf("challenge = %q, %q, %q, %v", challenge, token, text, err)
	}
	_, _, text, err = parseFeishuCallback([]byte(`{"token":"tok","type":"message","text":"旧版消息"}`))
	if err != nil || text != "旧版消息" {
		t.Fatalf("v1 = %q, %v", text, err)
	}
	if _, _, _, err := parseFeishuCallback([]byte("not json")); err == nil {
		t.Fatal("bad JSON parsed")
	}
}

func TestFeishuInboundHandler(t *testing.T) {
	post := func(h *remoteHost, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/feishu", strings.NewReader(body))
		h.handleFeishu(rec, req)
		return rec
	}
	off := &remoteHost{app: &app{st: &store{c: &config{FeishuVerifyToken: "tok"}}}}
	if rec := post(off, `{"challenge":"abc","token":"tok"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("off = %d", rec.Code)
	}
	h := &remoteHost{app: &app{st: &store{c: &config{FeishuInbound: true, FeishuVerifyToken: "tok"}}}}
	rec := post(h, `{"challenge":"abc","token":"tok"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("challenge = %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]string
	if json.Unmarshal(rec.Body.Bytes(), &out) != nil || out["challenge"] != "abc" {
		t.Fatalf("challenge body = %s", rec.Body.String())
	}
	if rec := post(h, `{"challenge":"abc","token":"nope"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d", rec.Code)
	}
	noToken := &remoteHost{app: &app{st: &store{c: &config{FeishuInbound: true}}}}
	if rec := post(noToken, `{"challenge":"abc","token":""}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("empty token = %d", rec.Code)
	}
}

func TestFeishuInboundSettings(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-integrations")
	app.WaitFor("id:feishu-inbound", 5*time.Second)
	app.Press("id:feishu-inbound")
	app.WaitFor("id:feishu-verify-token", 5*time.Second)
	app.Type("id:feishu-verify-token", "tok-1")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err == nil && strings.Contains(string(raw), `"feishuInbound": true`) && strings.Contains(string(raw), "tok-1") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("config = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
