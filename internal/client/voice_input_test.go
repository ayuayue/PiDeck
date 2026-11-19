package client

// The phone's microphone ends where the desktop begins: the transcript is
// appended to the composer, and the client asks the desktop for it.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVoiceInsert(t *testing.T) {
	draft := ""
	insert := voiceInsert(func() string { return draft }, func(v string) { draft = v })
	insert(" 打开设置 ")
	if draft != "打开设置" {
		t.Fatalf("draft = %q", draft)
	}
	insert("再保存")
	if draft != "打开设置 再保存" {
		t.Fatalf("draft = %q", draft)
	}
	insert("")
	if draft != "打开设置 再保存" {
		t.Fatalf("an empty transcript changed the draft: %q", draft)
	}
}

func TestRemoteClientVoice(t *testing.T) {
	var gotToken string
	var gotBody remotewireVoiceRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"text":"你好"}`))
	}))
	defer srv.Close()
	client := &remoteClient{base: srv.URL, token: "phone-token", http: srv.Client()}
	text, err := client.voice([]byte("RIFFwav"))
	if err != nil || text != "你好" {
		t.Fatalf("voice = %q, %v", text, err)
	}
	if gotToken != "Bearer phone-token" {
		t.Fatalf("authorization = %q", gotToken)
	}
	if gotBody.Format != "wav" {
		t.Fatalf("format = %q", gotBody.Format)
	}
	if data, _ := base64.StdEncoding.DecodeString(gotBody.Data); string(data) != "RIFFwav" {
		t.Fatalf("audio = %q", data)
	}
}

// remotewireVoiceRequest is the body the test reads back, named apart from
// the wire type so a rename there fails to compile here.
type remotewireVoiceRequest struct {
	Format string `json:"format"`
	Data   string `json:"data"`
}
