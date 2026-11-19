//go:build !js && !android && !ios

package workbench

// Drives the phone's composer controls against a real app: the mode of the
// next turn, the backend a blank session can still change, the draft tools
// the desktop's models run, and a picture drawn for the phone.

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

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestRemoteComposerControls(t *testing.T) {
	// A provider that draws a picture and answers a chat completion; the
	// phone's controls reach it through the app's own configuration.
	pixel, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	var promptAsked, imageAsked string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/images/generations":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			imageAsked, _ = body["prompt"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": tinyPNG}}})
		case "/chat/completions":
			var body struct {
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body.Messages) > 0 {
				promptAsked = body.Messages[len(body.Messages)-1].Content
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{{"message": map[string]string{"content": "改写后的提示词"}}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()

	piDir := t.TempDir()
	models := map[string]any{"providers": map[string]any{"acme": map[string]any{
		"baseUrl": provider.URL, "apiKey": "k",
		"models": []map[string]any{{"id": "chat-1", "name": "Chat 1"}, {"id": "img-1", "name": "Img 1"}},
	}}}
	rawModels, err := json.Marshal(models)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(piDir, "models.json"), rawModels, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_PI_CONFIG", piDir)

	home := t.TempDir()
	// The app keeps a watcher on the workspace; its folder is removed by
	// hand so the test's own cleanup does not race it.
	workspace, err := os.MkdirTemp("", "pideck-composer")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		time.Sleep(200 * time.Millisecond)
		_ = os.RemoveAll(workspace)
	})
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "ComposerProject"}},
		Theme: "system", SidebarOpen: true, ScanPi: false,
		ImageProvider: "acme", ImageModel: "img-1", ImageSize: "512x512",
		ToolModels: map[string]toolModelCfg{"prompt": {Provider: "acme", Model: "chat-1"}}})
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

	call := func(method, path, body string) *httptest.ResponseRecorder {
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			req := httptest.NewRequest(method, path, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer phone-token")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			done <- rec
		}()
		deadline := time.Now().Add(20 * time.Second)
		for {
			select {
			case rec := <-done:
				return rec
			default:
				if time.Now().After(deadline) {
					t.Fatal("request timed out")
				}
				screen.Settle()
				time.Sleep(2 * time.Millisecond)
			}
		}
	}
	session := func() remotewire.Session {
		rec := call(http.MethodGet, "/api/state", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("state = %d: %s", rec.Code, rec.Body.String())
		}
		var snap remotewire.Snapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		for _, p := range snap.Projects {
			for _, s := range p.Sessions {
				return s
			}
		}
		t.Fatal("no session in the state")
		return remotewire.Session{}
	}
	options := func() remotewire.Options {
		rec := call(http.MethodGet, "/api/session/"+session().ID+"/options", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("options = %d: %s", rec.Code, rec.Body.String())
		}
		var out remotewire.Options
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	rec := call(http.MethodPost, "/api/sessions", `{"project":`+"\""+filepath.ToSlash(workspace)+"\""+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create = %d: %s", rec.Code, rec.Body.String())
	}
	id := session().ID
	if id == "" {
		t.Fatal("no session id")
	}

	// The phone learns the backend choices and the draft tools it can use.
	opts := options()
	if opts.Backend != "pi" || len(opts.Backends) == 0 || opts.Backends[0].ID != "pi" {
		t.Fatalf("options = %+v", opts)
	}
	if len(opts.Tools) != 1 || opts.Tools[0] != "prompt" {
		t.Fatalf("tools = %+v, want just prompt", opts.Tools)
	}

	// A normal prompt is the start; plan and goal ride on the session, and
	// an unknown mode is refused.
	for _, mode := range []string{"plan", "goal", "imagegen"} {
		rec = call(http.MethodPost, "/api/sessions/"+id+"/mode", `{"mode":"`+mode+`"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("mode %s = %d: %s", mode, rec.Code, rec.Body.String())
		}
		if got := session().Mode; got != mode {
			t.Fatalf("mode after %s = %q", mode, got)
		}
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/mode", `{"mode":"party"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown mode = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/mode", `{"mode":"normal"}`)
	if rec.Code != http.StatusOK || session().Mode != "" {
		t.Fatalf("normal mode = %d, %q", rec.Code, session().Mode)
	}

	// The picture is drawn by the desktop and handed to the phone.
	rec = call(http.MethodPost, "/api/sessions/"+id+"/image", `{"prompt":"一只猫"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("image = %d: %s", rec.Code, rec.Body.String())
	}
	var pictures remotewire.Pictures
	if err := json.Unmarshal(rec.Body.Bytes(), &pictures); err != nil {
		t.Fatal(err)
	}
	if len(pictures.Images) != 1 || pictures.Images[0].Mime != "image/png" {
		t.Fatalf("pictures = %+v", pictures)
	}
	if data, err := base64.StdEncoding.DecodeString(pictures.Images[0].Data); err != nil || len(data) != len(pixel) {
		t.Fatalf("picture bytes = %d, %v", len(data), err)
	}
	if imageAsked != "一只猫" {
		t.Fatalf("image prompt = %q", imageAsked)
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/image", `{"prompt":" "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty image prompt = %d: %s", rec.Code, rec.Body.String())
	}

	// A draft tool answers with the desktop's model.
	rec = call(http.MethodPost, "/api/sessions/"+id+"/tools", `{"tool":"prompt","text":"把测试跑一遍"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("tool = %d: %s", rec.Code, rec.Body.String())
	}
	var rewritten struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rewritten); err != nil || rewritten.Text != "改写后的提示词" {
		t.Fatalf("tool text = %+v, %v", rewritten, err)
	}
	if promptAsked != "把测试跑一遍" {
		t.Fatalf("tool prompt = %q", promptAsked)
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/tools", `{"tool":"predict","text":"写"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unconfigured tool = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/tools", `{"tool":"party","text":"写"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown tool = %d: %s", rec.Code, rec.Body.String())
	}

	// The backend can still change; an unknown preset is refused.
	presets := built.acpPresetList()
	if len(presets) == 0 {
		t.Skip("this build has no ACP presets")
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/backend", `{"backend":"acp","preset":"nope"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown preset = %d: %s", rec.Code, rec.Body.String())
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/backend", `{"backend":"acp","preset":"`+presets[0].ID+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("backend = %d: %s", rec.Code, rec.Body.String())
	}
	if got := options().Backend; got != "acp:"+presets[0].ID {
		t.Fatalf("backend after switch = %q", got)
	}

	// Its first message fixes the backend; changing it then is refused.
	rec = call(http.MethodPost, "/api/sessions/"+id+"/prompt", `{"text":"先跑一轮"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("prompt = %d: %s", rec.Code, rec.Body.String())
	}
	if got := options().BackendLocked; !got {
		t.Fatal("the backend is not locked after a message")
	}
	rec = call(http.MethodPost, "/api/sessions/"+id+"/backend", `{"backend":"pi"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("locked backend = %d: %s", rec.Code, rec.Body.String())
	}
}
