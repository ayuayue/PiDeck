package main

// Checks image generation: both response shapes and the dialog's path to
// the composer.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func TestGenerateImage(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	mode := "b64"
	var gotN float64
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/images/generations":
			var req map[string]any
			_ = json.NewDecoder(r.Body).Decode(&req)
			gotN, _ = req["n"].(float64)
			if mode == "url" {
				_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"url": srv.URL + "/img.png"}}})
				return
			}
			if mode == "bad" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"no image"}`))
				return
			}
			items := []map[string]string{{"b64_json": tinyPNG}}
			if gotN >= 2 {
				items = append(items, map[string]string{"b64_json": tinyPNG})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": items})
		case r.URL.Path == "/img.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	cfg := providerConfig{ID: "acme", BaseURL: srv.URL, APIKey: "k"}

	images, err := generateImage(cfg, "img-1", "a cat", "1024x1024", 1)
	if err != nil || len(images) != 1 || images[0].Mime != "image/png" || !bytes.Equal(images[0].Data, png) {
		t.Fatalf("b64 = %+v, %v", images, err)
	}
	if gotN != 1 {
		t.Fatalf("n = %v, want 1", gotN)
	}
	mode = "url"
	images, err = generateImage(cfg, "img-1", "a cat", "1024x1024", 1)
	if err != nil || len(images) != 1 || images[0].Mime != "image/png" || !bytes.Equal(images[0].Data, png) {
		t.Fatalf("url = %+v, %v", images, err)
	}
	mode = "b64"
	images, err = generateImage(cfg, "img-1", "a cat", "1024x1024", 2)
	if err != nil || len(images) != 2 || gotN != 2 {
		t.Fatalf("two images = %d, n = %v, %v", len(images), gotN, err)
	}
	mode = "bad"
	if _, err := generateImage(cfg, "img-1", "a cat", "1024x1024", 1); err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("bad = %v", err)
	}
	if _, err := generateImage(providerConfig{ID: "x"}, "m", "p", "s", 1); err == nil {
		t.Fatal("a provider without a URL should fail")
	}
	if _, err := generateImage(cfg, "", "p", "s", 1); err == nil {
		t.Fatal("an empty model should fail")
	}
}

func TestImageDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		items := []map[string]string{{"b64_json": tinyPNG}}
		if n, _ := req["n"].(float64); n >= 2 {
			items = append(items, map[string]string{"b64_json": tinyPNG})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": items})
	}))
	defer srv.Close()
	home := t.TempDir()
	workspace := editorWorkspace(t)
	cfgDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	models := `{"providers":{"acme":{"api":"openai-completions","baseUrl":` + strconvQuote(srv.URL) + `,"apiKey":"k","models":[{"id":"chat-1"}]}}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "models.json"), []byte(models), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	app := openApp(t, workspace, 1280, 860)
	app.Press("id:rail-palette")
	app.Type("label:命令", "生成图片")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:生成图片…")) > 0 })
	app.Press("role:option 生成图片…")
	app.WaitFor("id:image-dialog", 5*time.Second)
	app.Type("id:image-prompt", "一只在窗台看雨的猫")
	app.Type("id:image-model", "img-1")
	app.Press("id:image-count-2")
	app.Press("id:image-generate")
	app.WaitFor("id:image-thumb-1", 15*time.Second)
	app.Press("id:image-regenerate")
	app.WaitFor("id:image-thumb-3", 15*time.Second)
	app.Press("id:image-thumb-0")
	app.Press("id:image-insert")
	if requests < 2 {
		t.Fatalf("requests = %d", requests)
	}
	app.WaitForGone("id:image-dialog", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:button 移除图片")) > 0 })
}

// strconvQuote is a JSON string literal, kept here so the test's models
// file needs no import of strconv.
func strconvQuote(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}
