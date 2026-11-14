package main

// Checks the vision bridge: the request it sends, the answers it reads,
// and the dialog that puts a description into the composer.

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

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestDescribeImage(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{
			"message": map[string]any{"content": "一只猫坐在窗台上。"}}}})
	}))
	defer srv.Close()
	raw, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	text, err := describeImage(providerConfig{ID: "acme", BaseURL: srv.URL, APIKey: "k"}, "vision-1", "", raw, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if text != "一只猫坐在窗台上。" {
		t.Fatalf("text = %q", text)
	}
	if body["model"] != "vision-1" {
		t.Fatalf("model = %v", body["model"])
	}
	messages, _ := body["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %v", body["messages"])
	}
	content, _ := messages[0].(map[string]any)["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("content = %v", content)
	}
	textPart, _ := content[0].(map[string]any)
	if textPart["text"] != defaultVisionQuestion {
		t.Fatalf("question = %v", textPart["text"])
	}
	imagePart, _ := content[1].(map[string]any)["image_url"].(map[string]any)
	url, _ := imagePart["url"].(string)
	if !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("image url = %.60q", url)
	}

	parts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{
			"message": map[string]any{"content": []map[string]string{
				{"type": "text", "text": "一只"}, {"type": "text", "text": "猫"}}}}}})
	}))
	defer parts.Close()
	text, err = describeImage(providerConfig{ID: "acme", BaseURL: parts.URL, APIKey: "k"}, "vision-1", "图里是什么？", raw, "")
	if err != nil || text != "一只猫" {
		t.Fatalf("parts = %q, %v", text, err)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer bad.Close()
	if _, err := describeImage(providerConfig{ID: "acme", BaseURL: bad.URL}, "vision-1", "", raw, ""); err == nil ||
		!strings.Contains(err.Error(), "401") {
		t.Fatalf("error = %v", err)
	}
}

func TestVisionDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{
			"message": map[string]any{"content": "一张窗台上的猫的照片。"}}}})
	}))
	defer srv.Close()
	home := t.TempDir()
	workspace := editorWorkspace(t)
	cfgDir := t.TempDir()
	raw, err := base64.StdEncoding.DecodeString(tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	photo := filepath.Join(workspace, "photo.png")
	if err := os.WriteFile(photo, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	models := `{"providers":{"acme":{"api":"openai-completions","baseUrl":` + strconvQuote(srv.URL) + `,"apiKey":"k","models":[{"id":"vision-1"}]}}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "models.json"), []byte(models), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	app := openApp(t, workspace, 1280, 860)
	app.Press("id:rail-palette")
	app.Type("label:命令", "描述图片")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:描述图片…")) > 0 })
	app.Press("role:option 描述图片…")
	app.WaitFor("id:vision-dialog", 5*time.Second)
	typeAll(t, app, "id:vision-path", photo)
	app.Type("id:vision-model", "vision-1")
	for i := 0; i < 4 && len(app.Query("id:vision-result")) == 0; i++ {
		if len(app.Query("id:vision-run")) > 0 {
			app.Press("id:vision-run")
		}
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitFor("id:vision-result", 10*time.Second)
	for i := 0; i < 4 && len(app.Query("id:vision-dialog")) > 0; i++ {
		app.Press("id:vision-insert")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitForGone("id:vision-dialog", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool {
		return strings.Contains(app.Find("id:composer").Text, "一张窗台上的猫的照片。")
	})
}
