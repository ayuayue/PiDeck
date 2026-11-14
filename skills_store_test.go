package main

// Checks the skill store: its index, an install into pi's skills folder,
// and the dialog that does it.

import (
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

const testSkillBody = `---
name: 团队技能
description: 团队的发布检查清单
---

# 团队技能

发布前逐项检查。
`

func TestSkillIndexAndInstall(t *testing.T) {
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	body := "---\nname: 团队技能\ndescription: 发布检查\n---\n\n# 团队技能\n\n发布前逐项检查。\n"
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/skills.json":
			_ = json.NewEncoder(w).Encode(map[string]any{"skills": []map[string]string{
				{"id": "release", "name": "团队技能", "description": "发布检查", "url": srvURL + "/release/SKILL.md"},
				{"id": "../bad", "name": "坏技能", "url": srvURL + "/bad.md"},
				{"id": "plain", "name": "无协议", "url": "file:///etc/passwd"},
			}})
		case "/release/SKILL.md":
			_, _ = w.Write([]byte(body))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	list, err := fetchSkillIndex(srv.URL + "/skills.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != "release" {
		t.Fatalf("index = %+v", list)
	}
	path, err := installSkill(list[0])
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(cfgDir, "skills", "release", "SKILL.md")
	if path != want {
		t.Fatalf("installed at %q, want %q", path, want)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != body {
		t.Fatalf("installed body = %q", raw)
	}
	if !skillInstalled("release") {
		t.Fatal("skillInstalled said no")
	}
	if skillInstalled("missing") {
		t.Fatal("skillInstalled said yes for a missing skill")
	}
}

func TestSkillInstallRejectsEmpty(t *testing.T) {
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("  \n"))
	}))
	defer srv.Close()
	if _, err := installSkill(skillIndexEntry{ID: "empty", Name: "空", URL: srv.URL}); err == nil ||
		!strings.Contains(err.Error(), "空") {
		t.Fatalf("error = %v", err)
	}
	if _, err := installSkill(skillIndexEntry{ID: "bad/id", Name: "坏", URL: srv.URL}); err == nil {
		t.Fatal("a bad id installed")
	}
}

func TestSkillStoreDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/skills.json":
			_ = json.NewEncoder(w).Encode(map[string]any{"skills": []map[string]string{
				{"id": "release", "name": "团队技能", "description": "发布检查", "url": srvURL + "/release/SKILL.md"},
			}})
		case "/release/SKILL.md":
			_, _ = w.Write([]byte(testSkillBody))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-resources", 5*time.Second)
	app.Press("id:settings-tab-resources")
	app.WaitFor("id:skill-store-open", 5*time.Second)
	app.Press("id:skill-store-open")
	app.WaitFor("id:skill-store", 5*time.Second)
	typeAll(t, app, "id:skill-store-url", srv.URL+"/skills.json")
	for i := 0; i < 4; i++ {
		app.Press("id:skill-store-load")
		if waitQuiet(app, "id:skill-store-entry-release", 3*time.Second) {
			break
		}
	}
	installed := filepath.Join(cfgDir, "skills", "release", "SKILL.md")
	deadline := time.Now().Add(20 * time.Second)
	for {
		if _, err := os.Stat(installed); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the skill was not installed")
		}
		if len(app.Query("id:skill-store-install-release")) > 0 {
			app.Press("id:skill-store-install-release")
		}
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:已安装")) > 0 })
	app.Press("id:skill-store-close")
	app.WaitForGone("id:skill-store", 5*time.Second)
	app.WaitUntil(20*time.Second, func() bool { return len(app.Query("text:团队技能")) > 0 })
	raw, err := os.ReadFile(installed)
	if err != nil || !strings.Contains(string(raw), "发布前逐项检查") {
		t.Fatalf("installed file = %q, %v", raw, err)
	}
}
