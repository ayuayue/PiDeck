//go:build !js && !android && !ios

package workbench

// A list of names is a list of brands: the model picker, the provider rows and
// the agent picker all draw the mark of what they list, and a name the brand
// set does not know keeps its row's alignment.

import (
	"testing"
	"time"
)

// TestModelPickerShowsBrandMarks pins the two halves of the behaviour: a model
// whose family the set knows starts further in than one it does not, because
// its mark sits before the name, and both names stay inside the popup.
func TestModelPickerShowsBrandMarks(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		// The trigger shows this one, so neither listed name appears twice.
		sess.model.Set(modelInfo{Provider: "fixture", ID: "chosen", Name: "Chosen Model"})
		sess.models.Set([]modelInfo{
			{Provider: "openai", ID: "gpt-5", Name: "GPT Fixture", ContextWindow: 400_000},
			{Provider: "fixture", ID: "plain-model", Name: "Plain Fixture", ContextWindow: 400_000},
		})
	})
	screen.Press("id:model-picker")
	screen.WaitFor("id:model-search", 10*time.Second)
	branded := screen.Find("text:GPT Fixture").Bounds()
	plain := screen.Find("text:Plain Fixture").Bounds()
	popup := screen.Find("id:model-search").Bounds()
	if branded.Origin.X <= plain.Origin.X {
		t.Fatalf("a branded model starts at x=%v and an unknown one at x=%v: the mark did not take its own width",
			branded.Origin.X, plain.Origin.X)
	}
	if plain.Origin.X+plain.Size.Width > popup.Origin.X+popup.Size.Width+1 {
		t.Fatalf("plain name %v runs past the popup %v", plain, popup)
	}
}

// TestACPBadgeFitsItsAgentName guards the chip that names an ACP agent: the
// mark sits between its status dot and its name without pushing the name out of
// the chip, and the chip stays inside the composer's controls.
func TestACPBadgeFitsItsAgentName(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		// A blank session: the first message is what locks a backend.
		sess.turns.Set(nil)
		built.setBackend(sess, "acp", "claude")
	})
	screen.WaitFor("id:acp-mode-badge", 10*time.Second)
	badge := screen.Find("id:acp-mode-badge").Bounds()
	name := screen.Find("id:acp-mode-badge >> text:Claude Agent").Bounds()
	controls := screen.Find("id:composer-model-controls").Bounds()
	if name.Origin.X <= badge.Origin.X {
		t.Fatalf("the name %v starts at the chip's own left edge %v", name, badge)
	}
	if name.Origin.X+name.Size.Width > badge.Origin.X+badge.Size.Width+1 {
		t.Fatalf("the chip's name %v runs past the chip %v", name, badge)
	}
	if badge.Origin.X < controls.Origin.X-1 || badge.Origin.X+badge.Size.Width > controls.Origin.X+controls.Size.Width+1 {
		t.Fatalf("the chip %v runs out of the composer's controls %v", badge, controls)
	}
}
