//go:build !js && !android && !ios

package workbench

// Checks the plugin scaffolder: the id it accepts, the manifest it writes,
// and the command that shows up afterwards.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPluginIDProblem(t *testing.T) {
	ok := []string{"my-tools", "ab", "a1"}
	for _, id := range ok {
		if problem := pluginIDProblem(id); problem != "" {
			t.Errorf("pluginIDProblem(%q) = %q, want none", id, problem)
		}
	}
	bad := []string{"", "A", "1abc", "my_tools", "a", "with space", "工具"}
	for _, id := range bad {
		if pluginIDProblem(id) == "" {
			t.Errorf("pluginIDProblem(%q) = none, want a problem", id)
		}
	}
}

func TestPluginTemplate(t *testing.T) {
	raw, err := pluginTemplate("my-tools", "我的工具", "")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Version     string `json:"version"`
		Description string `json:"description"`
		Contributes struct {
			Commands []struct {
				ID     string `json:"id"`
				Title  string `json:"title"`
				Action struct {
					Type   string `json:"type"`
					Prompt string `json:"prompt"`
				} `json:"action"`
			} `json:"commands"`
			Settings []struct {
				Key  string `json:"key"`
				Type string `json:"type"`
			} `json:"settings"`
		} `json:"contributes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("manifest is not JSON: %v\n%s", err, raw)
	}
	if doc.ID != "my-tools" || doc.Name != "我的工具" || doc.Version == "" || doc.Description == "" {
		t.Fatalf("manifest = %+v", doc)
	}
	if len(doc.Contributes.Commands) != 1 || doc.Contributes.Commands[0].Title != "你好，我的工具" ||
		doc.Contributes.Commands[0].Action.Type != "prompt" || doc.Contributes.Commands[0].Action.Prompt == "" {
		t.Fatalf("commands = %+v", doc.Contributes.Commands)
	}
	if len(doc.Contributes.Settings) != 1 || doc.Contributes.Settings[0].Key != "greeting" {
		t.Fatalf("settings = %+v", doc.Contributes.Settings)
	}
}

// TestNewPlugin creates a plugin from the dialog and finds its command in
// the palette.
func TestNewPlugin(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := startApp(t, dir, 1280, 860)

	app.Press("id:rail-palette")
	app.Type("label:命令", "新建插件")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 新建插件…")) > 0 })
	app.Press("role:option 新建插件…")
	app.WaitFor("id:plugin-new", 5*time.Second)
	app.Type("id:plugin-new-id", "my-tools")
	app.Type("id:plugin-new-name", "我的工具")
	app.Press("id:plugin-new-create")
	waitPath(t, filepath.Join(home, "plugins", "my-tools", "plugin.json"), true)

	app.Press("id:rail-palette")
	app.Type("label:命令", "你好，我的工具")
	app.WaitUntil(15*time.Second, func() bool { return len(app.Query("role:option 你好，我的工具")) > 0 })
}
