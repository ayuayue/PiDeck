//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsEnvironmentEditorActionsInline(t *testing.T) {
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	editors := []extEditor{{"VS Code", "/applications/" + strings.Repeat("long-location/", 8) + "code"}, {"Zed", "/applications/zed"}}
	screen.Post(func() { built.externalEditors.Set(editors) })
	screen.WaitFor("text:VS Code", 5*time.Second)
	for i, editor := range editors {
		key := editorKey(editor.Command)
		row := screen.Find("id:external-editor-" + key).Bounds()
		label := screen.Find("text:" + editor.Name).Bounds()
		path := screen.Find("id:editor-command-" + key).Bounds()
		if i == 0 && label.Size.Width < 32 {
			t.Errorf("editor name was squeezed out by the path: %+v", label)
		}
		if row.Size.Height > 40 {
			t.Errorf("single-line editor row is too tall for %q: %+v", editor.Name, row)
		}
		if path.Size.Height > 20 || path.Origin.Y > label.Origin.Y+label.Size.Height || path.Origin.Y+path.Size.Height < label.Origin.Y {
			t.Errorf("editor path is not a single inline detail: id=editor-command-%s name=%+v path=%+v", key, label, path)
		}
		actions := []string{"editor-remove-" + key}
		if i > 0 {
			actions = append(actions, "editor-default-"+key)
		}
		for _, id := range actions {
			button := screen.Find("id:" + id).Bounds()
			if button.Origin.Y > label.Origin.Y+label.Size.Height || button.Origin.Y+button.Size.Height < label.Origin.Y {
				t.Errorf("editor action is not inline with its name: id=%s label=%+v action=%+v", id, label, button)
			}
			viewport := screen.Find("id:settings-page").Bounds()
			if button.Origin.X+button.Size.Width > viewport.Origin.X+viewport.Size.Width-viewkit.PanelInset+1 {
				t.Errorf("editor action overlaps the scrollbar gutter: id=%s action=%+v viewport=%+v", id, button, viewport)
			}
		}
	}
	if nsgotest.Target() != "" {
		screen.Focus("id:editor-remove-" + editorKey(editors[0].Command))
		screen.Screenshot("settings-runtime-inline-editor-actions")
	}
}
