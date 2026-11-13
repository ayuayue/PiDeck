package main

// Checks the trust gate: a new project warns, and sending asks once.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestTrustGate(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("id:rail-palette")
	app.Press("text:浏览文件夹添加工作区")
	app.WaitFor("text:选择这个文件夹", 5*time.Second)
	app.Clear("label:文件夹路径")
	app.Type("label:文件夹路径", workspace)
	app.Submit("label:文件夹路径")
	app.WaitFor("text:note.txt", 5*time.Second)
	app.Press("text:选择这个文件夹")
	app.WaitFor("text:打开一个会话，或者新建一个。", 5*time.Second)
	app.Press("id:welcome-primary")
	app.WaitFor("id:composer", 10*time.Second)
	app.WaitFor("id:trust-bar", 5*time.Second)

	app.Type("id:composer", "hi")
	app.Press("role:button 发送")
	app.WaitFor("id:trust-dialog", 5*time.Second)
	app.Press("id:trust-ok")
	app.WaitForGone("id:trust-bar", 5*time.Second)
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "trustedProjects") {
		t.Fatalf("config = %s", raw)
	}
}
