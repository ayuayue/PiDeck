package client

// The phone reads a list of models and agents the way the desktop does: a
// brand the set knows takes its own width before the name, and a name it does
// not know keeps the row's alignment.

import (
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestMobileModelSheetShowsBrandMarks pins the sheet's reading: the model the
// set knows starts further in than the one it does not, because its mark sits
// before the name.
func TestMobileModelSheetShowsBrandMarks(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "id:mobile-model", 15*time.Second)
	app.Press("id:mobile-model")
	waitApp(app, "id:mobile-options-sheet", 10*time.Second)
	waitApp(app, "text:GPT 模型", 10*time.Second)

	branded := app.Find("id:mobile-options-sheet >> text:GPT 模型").Bounds()
	plain := app.Find("id:mobile-options-sheet >> text:模型一").Bounds()
	if branded.Origin.X <= plain.Origin.X {
		t.Fatalf("a branded model starts at x=%v and an unknown one at x=%v: the mark did not take its own width",
			branded.Origin.X, plain.Origin.X)
	}
}

// TestMobileBackendRowsShowTheirAgent covers the other list the sheet holds:
// the ACP backend carries its agent's mark, and pi, which the set does not
// have a mark for, starts its name where the row starts.
func TestMobileBackendRowsShowTheirAgent(t *testing.T) {
	desk := newComposerDesktop(t)
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-draft", 10*time.Second)
	app.Press("id:mobile-model")
	waitApp(app, "id:mobile-options-sheet", 10*time.Second)
	app.WaitFor("text:ACP Claude", 10*time.Second)

	agent := app.Find("id:mobile-options-sheet >> text:ACP Claude").Bounds()
	pi := app.Find("id:mobile-backend-row >> text:pi").Bounds()
	if agent.Origin.X <= pi.Origin.X {
		t.Fatalf("the ACP row's name starts at x=%v and pi's at x=%v: the agent's mark took no width",
			agent.Origin.X, pi.Origin.X)
	}
}
