//go:build windows

package workbench

import (
	"fmt"
	"os"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// A client-area mouse gesture bypasses WM_NCHITTEST in nsgotest.Drag.
// Ask Windows itself whether the real header is a caption, not just whether
// the mounted tree contains a WindowDragOn prop.
func TestHeaderNativeHitTest(t *testing.T) {
	a, screen, hit := headerNativeFixture(t)
	for _, selector := range []string{"id:tab-bar-drag", "id:sidebar-header"} {
		if code := hit(selector, nil); code != 2 { // HTCAPTION
			t.Errorf("%s returns hit %d, want HTCAPTION (2)", selector, code)
		}
	}
	for _, selector := range []string{"id:tab", "id:rail-palette", "id:window-close"} {
		if code := hit(selector, nil); code != 1 { // HTCLIENT
			t.Errorf("%s returns hit %d, want an interactive client control (1)", selector, code)
		}
	}
	screen.Press("id:drawer-toggle")
	screen.Advance(300 * time.Millisecond)
	screen.WaitFor("id:right-header", 5*time.Second)
	if code := hit("id:right-header", &core.Point{X: 8, Y: 24}); code != 2 {
		t.Errorf("the drawer header returns hit %d, want HTCAPTION (2)", code)
	}
	onNativeUI(t, screen, a, func() {
		a.toaster.Show(ui.ToastContent{ID: "header-toast", Title: "Header drag", Duration: -1})
	})
	screen.Advance(300 * time.Millisecond)
	toast := screen.Find("id:header-toast").Bounds()
	if toast.Origin.Y < ui.HeaderHeight+16 {
		t.Fatalf("the toast moved into the header: %+v", toast)
	}
	shot(screen, "header-drag/notification-visible")
	for _, state := range []string{"shown", "dismissed"} {
		if state == "dismissed" {
			screen.Press("id:header-toast-close")
			screen.Advance(300 * time.Millisecond)
			screen.WaitForGone("id:header-toast", 5*time.Second)
		}
		for _, selector := range []string{"id:tab-bar-drag", "id:sidebar-header"} {
			if code := hit(selector, nil); code != 2 {
				t.Errorf("%s with the toast %s returns hit %d, want HTCAPTION", selector, state, code)
			}
		}
		if code := hit("id:right-header", &core.Point{X: 8, Y: 24}); code != 2 {
			t.Errorf("the drawer header with the toast %s returns hit %d, want HTCAPTION", state, code)
		}
	}
	// Header buttons still open their dialog, and closing it restores dragging.
	screen.Press("id:rail-palette")
	screen.WaitFor("id:palette", 5*time.Second)
	screen.Key("escape")
	screen.WaitForGone("id:palette", 5*time.Second)
	if code := hit("id:tab-bar-drag", nil); code != 2 {
		t.Errorf("the header after closing the palette returns hit %d, want HTCAPTION (2)", code)
	}
}

func headerNativeFixture(t *testing.T) (*app, *nsgotest.App, func(string, *core.Point) uintptr) {
	t.Helper()
	if nsgotest.Target() == "" {
		t.Skip("needs a native Windows window")
	}
	a, screen := startNativeSettingsApp(t)
	title := fmt.Sprintf("PiDeck header hit test %d", os.Getpid())
	ws := &workspace{Path: t.TempDir()}
	onNativeUI(t, screen, a, func() {
		a.sidebar.Set(true)
		s := a.blankSession("header-drag", ws, "Header drag")
		a.byID[s.ID] = s
		a.all = append(a.all, s)
		a.tabs.Set([]string{s.ID})
		a.activeID.Set(s.ID)
		desktop.SetTitle(a.cx, title)
	})
	screen.Advance(300 * time.Millisecond)
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.FindMounted("id:sidebar-slot").Bounds().Size.Width > 280
	})
	user32 := syscall.NewLazyDLL("user32.dll")
	findWindow := user32.NewProc("FindWindowW")
	wideTitle, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		t.Fatal(err)
	}
	var hwnd uintptr
	screen.WaitUntil(5*time.Second, func() bool {
		hwnd, _, _ = findWindow.Call(0, uintptr(unsafe.Pointer(wideTitle)))
		return hwnd != 0
	})
	clientToScreen := user32.NewProc("ClientToScreen")
	sendMessage := user32.NewProc("SendMessageW")
	dpi, _, _ := user32.NewProc("GetDpiForWindow").Call(hwnd)
	if dpi == 0 {
		t.Fatal("cannot read the test window's DPI")
	}
	hit := func(selector string, local *core.Point) uintptr {
		t.Helper()
		bounds := screen.FindMounted(selector).Bounds()
		x, y := bounds.Origin.X+bounds.Size.Width/2, bounds.Origin.Y+bounds.Size.Height/2
		if local != nil {
			x, y = bounds.Origin.X+local.X, bounds.Origin.Y+local.Y
		}
		point := struct{ X, Y int32 }{int32(float64(x)*float64(dpi)/96 + 0.5), int32(float64(y)*float64(dpi)/96 + 0.5)}
		if ok, _, _ := clientToScreen.Call(hwnd, uintptr(unsafe.Pointer(&point))); ok == 0 {
			t.Fatal("cannot locate the test window's client area")
		}
		packed := uintptr(uint32(uint16(point.X)) | uint32(uint16(point.Y))<<16)
		code, _, _ := sendMessage.Call(hwnd, 0x0084, 0, packed) // WM_NCHITTEST
		t.Logf("%s: bounds=%+v, screen=(%d,%d), hit=%d", selector, bounds, point.X, point.Y, code)
		return code
	}
	return a, screen, hit
}

// Loading animations in the work area must not extend its native hit search
// into the header, even with multiple tabs and a maximized window.
func TestHeaderMiddleNativeHitTest(t *testing.T) {
	a, screen, hit := headerNativeFixture(t)
	ws := &workspace{Path: t.TempDir()}
	onNativeUI(t, screen, a, func() {
		a.setTabWidthPct(9)
		a.railWidth.Set(257.6)
		a.drawerWidth.Set(359.2)
		ids := append([]string(nil), a.tabs.Get()...)
		for i, title := range []string{"Update checks", "Pictures", "General settings grouping"} {
			s := a.blankSession(fmt.Sprintf("middle-%d", i), ws, title)
			a.byID[s.ID] = s
			a.all = append(a.all, s)
			ids = append(ids, s.ID)
		}
		a.tabs.Set(ids)
	})
	screen.Press("id:drawer-toggle")
	screen.Advance(300 * time.Millisecond)
	screen.WaitFor("id:right-header", 5*time.Second)
	for _, state := range []string{"windowed", "maximized"} {
		if state == "maximized" {
			screen.Press("id:window-maximize")
			screen.WaitFor("id:window-restore", 5*time.Second)
			screen.Advance(300 * time.Millisecond)
		}
		for _, section := range []string{"browser-loading", "general", "env"} {
			onNativeUI(t, screen, a, func() {
				if section == "browser-loading" {
					a.openPane(paneBrowser)
					a.browser.nav.Set(core.WebNavigation{Loading: true})
					return
				}
				a.settingsTab.Set(section)
				a.openPane(paneSettings)
			})
			screen.Advance(300 * time.Millisecond)
			selector := "id:settings-tab-" + section
			if section == "browser-loading" {
				selector = "id:browser-loading"
			}
			screen.WaitFor(selector, 5*time.Second)
			blank := screen.FindMounted("id:tab-bar-drag").Bounds()
			header := screen.FindMounted("id:content-header").Bounds()
			if blank.Size.Width < 40 {
				t.Fatalf("the fixture has no usable empty middle header: %+v", blank)
			}
			for _, fraction := range []core.Points{0.2, 0.5, 0.8} {
				for _, y := range []core.Points{10, 24, 38} {
					point := core.Point{X: blank.Origin.X - header.Origin.X + blank.Size.Width*fraction, Y: y}
					if code := hit("id:content-header", &point); code != 2 {
						t.Errorf("middle header %s %s at %.0f%%, y=%v returns hit %d, want HTCAPTION (2)", state, section, fraction*100, y, code)
					}
				}
			}
			input := "id:settings-search"
			if section == "browser-loading" {
				input = "id:browser-address"
			}
			for _, selector := range []string{"id:tab >> nth=0", "id:window-close", input} {
				if code := hit(selector, nil); code != 1 {
					t.Errorf("%s in %s %s returns hit %d, want HTCLIENT (1)", selector, state, section, code)
				}
			}
		}
	}
}
