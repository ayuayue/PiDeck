//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestVideoProtocolAndArtifact(t *testing.T) {
	var origin string
	submits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/gateway/ark/v3/generations/tasks":
			submits++
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer video-key" {
				t.Error("incorrect submit method or auth")
			}
			var body struct {
				Duration   int
				Content    []struct{ Text string }
				Resolution string
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || body.Duration != 5 || body.Resolution != "720p" || len(body.Content) != 1 || body.Content[0].Text != "Test scene" {
				t.Errorf("incorrect submit body %+v", body)
			}
			w.Write([]byte(`{"id":"task/fixture"}`))
		case "/gateway/ark/v3/generations/tasks/task/fixture":
			json.NewEncoder(w).Encode(map[string]any{"status": "succeeded", "content": map[string]string{"video_url": origin + "/artifact"}})
		case "/artifact":
			if r.Header.Get("Authorization") != "" {
				t.Error("artifact received API key")
			}
			w.Write([]byte("\x00\x00\x00\x18ftypmp42fixture"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	origin = srv.URL
	cfg := providerConfig{ID: "fixture", BaseURL: srv.URL, APIKey: "video-key"}
	j := videoJob{Family: "ark", Model: "fixture-video", Prompt: "Test scene", Duration: 5, Resolution: "720P"}
	var err error
	j.Task, err = submitVideo(t.Context(), cfg, j)
	if err != nil {
		t.Fatal(err)
	}
	state, url, err := queryVideo(t.Context(), cfg, j)
	if err != nil || state != "succeeded" {
		t.Fatalf("query=%q %v", state, err)
	}
	file := filepath.Join(t.TempDir(), "blobs", "test.mp4")
	if err := downloadVideo(t.Context(), url, file); err != nil {
		t.Fatal(err)
	}
	if submits != 1 {
		t.Fatalf("submits=%d", submits)
	}
	for _, input := range []map[string]any{{"status": "unknown"}, {"status": "succeeded"}, {"status": "failed"}} {
		if _, _, err := videoStatus(input); err == nil {
			t.Fatalf("accepted invalid response %+v", input)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := downloadVideo(ctx, url, file); err == nil {
		t.Fatal("ignored cancellation")
	}
}

func TestVideoQueuePersistsWithoutResubmitting(t *testing.T) {
	home, cfgDir := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	submits := 0
	var origin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			submits++
			w.Write([]byte(`{"id":"one"}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/one") {
			json.NewEncoder(w).Encode(map[string]any{"status": "succeeded", "content": map[string]string{"video_url": origin + "/video"}})
			return
		}
		w.Write([]byte("\x00\x00\x00\x18ftypmp42fixture"))
	}))
	defer srv.Close()
	origin = srv.URL
	models := map[string]any{"providers": map[string]any{"fixture": map[string]any{"baseUrl": srv.URL, "apiKey": "k"}}}
	raw, _ := json.Marshal(models)
	if err := os.WriteFile(filepath.Join(cfgDir, "models.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { videoJobWrites.Wait() })
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { a = newApp(cx); return a.videoPane() }, nsgotest.Size(1000, 900))
	screen.WaitUntil(5*time.Second, func() bool { return a.video.ready.GetUntracked() })
	screen.Type("id:video-provider", "fixture")
	screen.Type("id:video-model", "fixture-video")
	screen.Type("id:video-prompt", "A scene")
	screen.Press("id:video-submit")
	screen.WaitUntil(10*time.Second, func() bool { list := a.video.jobs.GetUntracked(); return len(list) == 1 && list[0].Stored })
	j := a.video.jobs.GetUntracked()[0]
	if _, err := os.Stat(a.videoPath(j)); err != nil {
		t.Fatal(err)
	}
	videoJobWrites.Wait()
	list := readVideoJobs(filepath.Join(home, "video", "jobs.yaml"))
	if len(list) != 1 || !list[0].Stored || list[0].Task != "one" || submits != 1 {
		t.Fatalf("saved jobs=%+v submits=%d", list, submits)
	}
	// Resume an interrupted tracking record with an existing remote ID.
	j.State, j.Stored = "interrupted", false
	a.updateVideo(j)
	a.resumeVideo(j)
	screen.WaitUntil(10*time.Second, func() bool { return a.video.jobs.GetUntracked()[0].Stored })
	if submits != 1 {
		t.Fatalf("resuming tracking submitted %d paid jobs; want 1", submits)
	}
	a.removeVideoRecord(j.ID)
	if len(a.video.jobs.GetUntracked()) != 0 {
		t.Fatal("completed record could not be removed")
	}
	if _, err := os.Stat(a.videoPath(j)); err != nil {
		t.Fatalf("removing a record deleted its artifact: %v", err)
	}
}
