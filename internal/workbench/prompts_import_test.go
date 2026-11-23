//go:build !js && !android && !ios

package workbench

// Checks importing a shared prompt pack from a link.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestParsePromptPack(t *testing.T) {
	pack, err := parsePromptPack([]byte(`{"name":"团队","prompts":[
		{"title":"A","body":"do A","category":"团队"},
		{"title":"B","prompt":"do B"}
	]}`))
	if err != nil || len(pack.Prompts) != 2 || pack.Prompts[1].Body != "do B" {
		t.Fatalf("pack = %+v, %v", pack, err)
	}
	list, err := parsePromptPack([]byte(`[{"title":"C","body":"do C"}]`))
	if err != nil || len(list.Prompts) != 1 || list.Prompts[0].Title != "C" {
		t.Fatalf("array = %+v, %v", list, err)
	}
	if _, err := parsePromptPack([]byte(`{"x":1}`)); err == nil {
		t.Fatal("a pack without prompts should fail")
	}
	if _, err := parsePromptPack([]byte(`[{"title":"","body":""}]`)); err == nil {
		t.Fatal("a pack of empty entries should fail")
	}
}

func TestImportPromptPack(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	prompts := filepath.Join(dir, "prompts")
	if err := os.MkdirAll(prompts, 0o755); err != nil {
		t.Fatal(err)
	}
	existing := `{"name":"我的提示词","prompts":[{"title":"A","body":"old","category":"我的"}]}`
	if err := os.WriteFile(filepath.Join(prompts, "user.json"), []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	pack, err := parsePromptPack([]byte(`{"prompts":[
		{"title":"A","body":"dup"},
		{"title":"B","body":"new B"},
		{"title":"C","prompt":"new C"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	added, skipped, err := a.importPromptPack(pack)
	if err != nil || added != 2 || skipped != 1 {
		t.Fatalf("added/skipped = %d/%d, %v", added, skipped, err)
	}
	list := a.loadPrompts()
	byTitle := map[string]promptItem{}
	for _, p := range list {
		byTitle[p.Title] = p
	}
	if byTitle["B"].Body != "new B" || byTitle["B"].Category != "导入" {
		t.Fatalf("B = %+v", byTitle["B"])
	}
	if byTitle["C"].Body != "new C" {
		t.Fatalf("C = %+v", byTitle["C"])
	}
}

func TestPromptImportUI(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"prompts":[{"title":"导入测试提示词","body":"测试导入的正文","category":"导入"}]}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:rail-palette")
	app.Type("label:命令", "提示词库")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	app.Press("role:option >> nth=0")
	app.WaitFor("id:prompt-import", 5*time.Second)
	app.Press("id:prompt-import")
	app.WaitFor("id:prompt-import-dialog", 5*time.Second)
	app.Type("id:prompt-import-url", srv.URL+"/pack.json")
	app.Press("id:prompt-import-go")
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:导入测试提示词")) > 0 })
	if !strings.Contains(app.Find("text:导入测试提示词").Text, "导入测试提示词") {
		t.Fatal("the imported prompt is missing")
	}
}
