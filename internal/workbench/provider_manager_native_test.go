//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// These fixtures exercise the same controls as the headless journeys, while
// retaining screenshots for checking clipping and hierarchy on the native host.
func TestNativeProviderManagerWorkflowScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	a, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, a, func() { a.openSettingsPane(); a.openSettingsSection("models") })
	screen.WaitFor("id:provider-configure-fixture", 5*time.Second)
	shot(screen, "provider-manager/providers")
	screen.Press("id:provider-add")
	screen.WaitFor("id:provider-add-key", 5*time.Second)
	shot(screen, "provider-manager/add-provider")
	screen.Press("id:provider-add-cancel")
	screen.WaitForGone("id:provider-add-dialog", 5*time.Second)
	screen.Press("id:provider-configure-fixture")
	screen.WaitFor("id:provider-base", 5*time.Second)
	shot(screen, "provider-manager/connection")
	screen.Press("id:provider-tab-models")
	screen.WaitFor("id:provider-model-fixture-chat", 5*time.Second)
	shot(screen, "provider-manager/models")
	screen.Press("id:provider-model-fixture-chat")
	screen.WaitFor("id:provider-model-id", 5*time.Second)
	shot(screen, "provider-manager/model-editor")
	screen.Resize(900, 640)
	screen.Press("id:provider-model-advanced")
	screen.Scroll("id:provider-scroll", 1200)
	shot(screen, "provider-manager/model-editor-scrolled")
	save, dialog := screen.Find("id:provider-model-save").Bounds(), screen.Find("id:provider-dialog").Bounds()
	if save.Origin.Y < dialog.Origin.Y || save.Origin.Y+save.Size.Height > dialog.Origin.Y+dialog.Size.Height {
		t.Fatal("model save button is outside the narrow dialog")
	}
	screen.Resize(1520, 920)
	screen.Press("id:provider-model-cancel")
	screen.WaitFor("id:provider-model-more-fixture-chat", 5*time.Second)
	screen.Press("id:provider-model-more-fixture-chat")
	screen.Press("id:provider-model-advanced-fixture-chat")
	screen.WaitFor("id:provider-model-user-agent", 5*time.Second)
	shot(screen, "provider-manager/model-advanced")
	screen.Scroll("id:provider-scroll", 1200)
	shot(screen, "provider-manager/model-advanced-scrolled")
	screen.Press("id:provider-model-advanced-cancel")
	screen.Press("id:provider-tab-usage")
	screen.WaitFor("id:provider-usage-enabled", 5*time.Second)
	shot(screen, "provider-manager/usage")
	screen.Resize(900, 640)
	screen.Scroll("id:provider-scroll", 1200)
	shot(screen, "provider-manager/usage-scrolled")
	save, dialog = screen.Find("id:provider-usage-save").Bounds(), screen.Find("id:provider-dialog").Bounds()
	if save.Origin.Y < dialog.Origin.Y || save.Origin.Y+save.Size.Height > dialog.Origin.Y+dialog.Size.Height {
		t.Fatal("usage save button is outside the narrow dialog")
	}
	screen.Resize(1520, 920)
	screen.Press("id:provider-cancel")
	screen.WaitForGone("id:provider-dialog", 5*time.Second)
	screen.Press("id:models-tab-tools")
	screen.WaitFor("id:default-model-provider", 5*time.Second)
	shot(screen, "provider-manager/tools")
	screen.Resize(900, 640)
	shot(screen, "provider-manager/tools-narrow")
	screen.Press("id:models-tab-providers")
	screen.WaitFor("id:provider-configure-fixture", 5*time.Second)
	screen.Press("id:provider-manage-models-fixture")
	screen.WaitFor("id:provider-model-fixture-chat", 5*time.Second)
	shot(screen, "provider-manager/models-narrow")
	onNativeUI(t, screen, a, func() { a.theme.Set("dark"); a.applyTheme() })
	shot(screen, "provider-manager/models-dark")
}
