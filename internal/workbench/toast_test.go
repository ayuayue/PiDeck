//go:build !js && !android && !ios

package workbench

// The toasts' corner: top right, just under the window's header rather
// than at the very top edge.

import (
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// TestToastPlacement checks a toast stacks at the top right, clear of the
// header and of the window's edge.
func TestToastPlacement(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	const width, height = 1320, 860
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(width, height))
	screen.Advance(200 * time.Millisecond)

	built.toast(ui.ToastSuccess, apptext.T("已保存"), apptext.T("测试"))
	screen.Advance(200 * time.Millisecond)

	stack := screen.Find("id:toasts")
	if stack == nil {
		t.Fatal("the toasts are not on screen")
	}
	y := float64(stack.Frame.Origin.Y)
	if y < float64(ui.HeaderHeight) {
		t.Errorf("toasts start at y=%v, over the %v header", y, ui.HeaderHeight)
	}
	if y > height/4 {
		t.Errorf("toasts start at y=%v, too far below the header", y)
	}
	x, right := float64(stack.Frame.Origin.X), float64(stack.Frame.Origin.X+stack.Frame.Size.Width)
	if x < width/2 {
		t.Errorf("toasts start at x=%v, not on the right", x)
	}
	if right > width {
		t.Errorf("toasts reach x=%v, past the window's %v", right, width)
	}
}

// TestToastCopyOutlivesTheToast checks a toast with a description carries a
// copy button that puts the whole of it on the clipboard: the toast takes the
// text away on its own, and a failure's detail is what a report needs.
func TestToastCopyOutlivesTheToast(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1320, 860))
	screen.Advance(200 * time.Millisecond)

	if button := screen.Query("id:toast-copy"); len(button) != 0 {
		t.Fatal("a copy button is on screen before any toast")
	}
	built.toast(ui.ToastError, "打开会话失败", "rpc: session not found")
	screen.WaitFor("id:toast-copy", 5*time.Second)

	screen.Press("id:toast-copy")
	want := apptext.T("打开会话失败") + "\n" + apptext.T("rpc: session not found")
	if screen.Clipboard != want {
		t.Fatalf("copied toast = %q, want %q", screen.Clipboard, want)
	}
	screen.WaitFor("text:"+apptext.T("已复制"), 5*time.Second)
	screen.Advance(5 * time.Second)
	if button := screen.Query("id:toast-copy"); len(button) != 0 {
		t.Fatal("a copy button stayed on screen after the toasts were gone")
	}
}
