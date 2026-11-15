package main

// Checks image generation: both response shapes and the dialog's path to
// the composer.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
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

func TestImageResponseOverOldCap(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	big := append(append([]byte(nil), png...), make([]byte, 12<<10)...)
	b64 := base64.StdEncoding.EncodeToString(big)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": b64}}})
	}))
	defer srv.Close()
	images, err := generateImage(providerConfig{ID: "acme", BaseURL: srv.URL}, "m", "p", "s", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 1 || len(images[0].Data) != len(big) {
		t.Fatalf("a %d-byte picture came back as %d images", len(big), len(images))
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
	waitApp(app, "label:命令", 10*time.Second)
	app.Type("label:命令", "生成图片")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:生成图片…")) > 0 })
	app.Press("role:option 生成图片…")
	app.WaitFor("id:image-dialog", 5*time.Second)
	app.Type("id:image-prompt", "一只在窗台看雨的猫")
	app.Type("id:image-model", "img-1")
	app.Press("id:image-count-2")
	for i := 0; i < 4 && len(app.Query("id:image-thumb-1")) == 0; i++ {
		if len(app.Query("id:image-generate")) > 0 && app.Enabled("id:image-generate") {
			app.Press("id:image-generate")
		}
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitFor("id:image-thumb-1", 15*time.Second)
	app.Press("id:image-regenerate")
	app.WaitFor("id:image-thumb-3", 15*time.Second)
	app.Press("id:image-thumb-0")
	for i := 0; i < 4 && len(app.Query("id:image-dialog")) > 0; i++ {
		app.Press("id:image-insert")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	if requests < 2 {
		t.Fatalf("requests = %d", requests)
	}
	app.WaitForGone("id:image-dialog", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:button 移除图片")) > 0 })
}

func TestEditImage(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	var gotPath, gotModel, gotPrompt string
	var gotFile []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			t.Errorf("multipart: %v", err)
			return
		}
		gotModel = r.FormValue("model")
		gotPrompt = r.FormValue("prompt")
		file, _, err := r.FormFile("image")
		if err != nil {
			t.Errorf("image part: %v", err)
			return
		}
		defer file.Close()
		gotFile, _ = io.ReadAll(file)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": tinyPNG}}})
	}))
	defer srv.Close()
	images, err := editImage(providerConfig{ID: "acme", BaseURL: srv.URL, APIKey: "k"}, "img-1", "给它戴一顶帽子", "1024x1024", png, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/images/edits" || gotModel != "img-1" || gotPrompt != "给它戴一顶帽子" {
		t.Fatalf("path/model/prompt = %q, %q, %q", gotPath, gotModel, gotPrompt)
	}
	if !bytes.Equal(gotFile, png) {
		t.Fatalf("uploaded %d bytes, want %d", len(gotFile), len(png))
	}
	if len(images) != 1 || !bytes.Equal(images[0].Data, png) {
		t.Fatalf("images = %+v", images)
	}
	if _, err := editImage(providerConfig{ID: "acme", BaseURL: srv.URL}, "img-1", "p", "s", nil, ""); err == nil {
		t.Fatal("an empty image should fail")
	}
	if _, err := editImage(providerConfig{ID: "acme", BaseURL: srv.URL}, "img-1", "", "s", png, ""); err == nil {
		t.Fatal("an empty prompt should fail")
	}
}

func TestImageEditDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	edits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/edits" {
			t.Errorf("path = %s", r.URL.Path)
		}
		edits++
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": tinyPNG}}})
	}))
	defer srv.Close()
	home := t.TempDir()
	workspace := editorWorkspace(t)
	cfgDir := t.TempDir()
	png, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	photo := filepath.Join(workspace, "photo.png")
	if err := os.WriteFile(photo, png, 0o644); err != nil {
		t.Fatal(err)
	}
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
	app.Type("id:image-prompt", "给它戴一顶帽子")
	app.Type("id:image-model", "img-1")
	typeAll(t, app, "id:image-ref", photo)
	app.Press("id:image-generate")
	app.WaitFor("id:image-thumb-0", 15*time.Second)
	for i := 0; i < 4 && len(app.Query("id:image-dialog")) > 0; i++ {
		app.Press("id:image-insert")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	if edits != 1 {
		t.Fatalf("edits = %d", edits)
	}
	app.WaitForGone("id:image-dialog", 5*time.Second)
}

// strconvQuote is a JSON string literal, kept here so the test's models
// file needs no import of strconv.
func strconvQuote(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}
