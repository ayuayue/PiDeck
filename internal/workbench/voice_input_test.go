//go:build !js && !android && !ios

package workbench

// The phone's recording reaches the desktop's speech service: the route
// refuses a body it cannot read, says so when the desktop has no
// credentials, and returns the transcript it got.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/volcvoice"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestRemoteVoice(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, VoiceAppID: "app", VoiceAccessToken: "token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	screen := nsgotest.Start(t, root, nsgotest.Size(1200, 800))
	if built == nil || built.remote == nil {
		t.Fatal("the app did not build its remote host")
	}
	built.remote.mu.Lock()
	built.remote.token = "phone-token"
	built.remote.mu.Unlock()
	handler := built.remote.handler()

	// The speech service, answering as Volcano's flash endpoint does.
	var lastAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastAuth = r.Header.Get("X-Api-Access-Key")
		w.Header().Set("x-api-status-code", "20000000")
		_, _ = w.Write([]byte(`{"result":{"text":"打开设置"}}`))
	}))
	defer srv.Close()
	built.speech = &volcvoice.Client{HTTP: srv.Client(), Endpoint: srv.URL}

	call := func(body string) *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(http.MethodPost, "/api/voice", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer phone-token")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			done <- rec
		}()
		deadline := time.Now().Add(10 * time.Second)
		for {
			select {
			case rec := <-done:
				return rec
			case <-time.After(2 * time.Millisecond):
				if time.Now().After(deadline) {
					t.Fatal("request timed out")
				}
				screen.Settle()
			}
		}
	}

	voiceBody, _ := json.Marshal(remotewire.VoiceRequest{Format: "wav", Data: base64.StdEncoding.EncodeToString([]byte("RIFF0000WAVE"))})
	rec := call(string(voiceBody))
	if rec.Code != http.StatusOK {
		t.Fatalf("voice = %d: %s", rec.Code, rec.Body.String())
	}
	var out remotewire.VoiceText
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Text != "打开设置" {
		t.Fatalf("voice text = %+v, %v", out, err)
	}
	if lastAuth != "token" {
		t.Fatalf("the desktop sent %q as the access token", lastAuth)
	}

	// Empty audio is refused before any call.
	empty, _ := json.Marshal(remotewire.VoiceRequest{Format: "wav"})
	if rec := call(string(empty)); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty recording = %d: %s", rec.Code, rec.Body.String())
	}

	// Without credentials the desktop says where to set them.
	built.st.edit(func(c *config) { c.VoiceAppID, c.VoiceAccessToken = "", "" })
	if rec := call(string(voiceBody)); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured = %d: %s", rec.Code, rec.Body.String())
	}

	// A refusal from the service is not an empty transcript.
	built.st.edit(func(c *config) { c.VoiceAppID, c.VoiceAccessToken = "app", "wrong" })
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer bad.Close()
	built.speech = &volcvoice.Client{HTTP: bad.Client(), Endpoint: bad.URL}
	if rec := call(string(voiceBody)); rec.Code != http.StatusBadGateway {
		t.Fatalf("refused credentials = %d: %s", rec.Code, rec.Body.String())
	}
}
