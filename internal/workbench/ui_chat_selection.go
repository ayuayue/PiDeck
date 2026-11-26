//go:build !js && !android && !ios

package workbench

import (
	"slices"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// chatSelection belongs to the mounted transcript, not the stored session.
// Updating it only moves the action; it never rebuilds the selected text.
type chatSelection struct {
	value        *core.Signal[core.TextSelection]
	pointer      *core.Signal[core.Point]
	menuOpen     *core.Signal[bool]
	area         core.Ref
	pointerKnown bool
	// Native desktops clear a selection when the action is pressed. Keep
	// its snapshot while the pointer is over the action, until activation
	// or leaving it, so clearing on mouse-down cannot eat the click.
	overAction, cleared bool
	size                core.Size
}

func newChatSelection(cx *core.Scope) *chatSelection {
	// A selection carries slices, so it is not comparable: compare the text
	// and the ranges that decide what the actions show.
	return &chatSelection{value: core.NewSignalFunc(cx, core.TextSelection{}, sameTextSelection),
		pointer: core.NewSignal(cx, core.Point{}), menuOpen: core.NewSignal(cx, false)}
}

func (s *chatSelection) clear() {
	s.overAction, s.cleared = false, false
	s.menuOpen.Set(false)
	s.value.Set(core.TextSelection{})
}

// sameTextSelection reports whether two selections read the same, which a
// signal needs now that a selection carries slices.
func sameTextSelection(a, b core.TextSelection) bool {
	return a.Text == b.Text && a.Markdown == b.Markdown && a.HTML == b.HTML &&
		a.Bounds == b.Bounds && slices.Equal(a.Ranges, b.Ranges)
}

func (s *chatSelection) changed(selection core.TextSelection) {
	if strings.TrimSpace(selection.Text) == "" || selection.Bounds.Size.Width <= 0 || selection.Bounds.Size.Height <= 0 {
		// Native text selection clears on mouse-down, before the action's
		// press arrives. Keep the snapshot for that short hand-off; the
		// overlay's outside/cancel/leave handlers clear it for real exits.
		s.cleared = true
		if !s.overAction && !s.menuOpen.GetUntracked() {
			s.clear()
		}
		return
	}
	s.cleared = false
	s.value.Set(selection)
	// Windows offers Ctrl+C to the focused input before its text selection.
	// Selecting the transcript must leave that input's editing focus.
	if !s.area.HoldsFocus() {
		s.area.Focus()
	}
}

func (s *chatSelection) moved(e core.MouseEvent) {
	if e.PressedButton == core.MouseButtonLeft || s.value.GetUntracked().Text == "" {
		s.pointerKnown = true
		s.pointer.Set(e.PagePosition)
	}
}

func (s *chatSelection) released(e core.MouseButtonEvent) {
	if e.Button == core.MouseButtonLeft && s.value.GetUntracked().Text != "" {
		s.pointerKnown = true
		s.pointer.Set(e.PagePosition)
	}
}

func (s *chatSelection) resized(bounds core.Bounds) {
	if s.size != bounds.Size {
		s.size = bounds.Size
		s.clear()
	}
}

func (a *app) chatSelectionAction(s *chatSelection) core.Node {
	return core.Show{When: func() bool { return s.value.Get().Text != "" && !s.menuOpen.Get() }, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		cx.OnKey("mod+c", func() {
			if !s.cleared {
				cx.SetClipboard(s.value.GetUntracked().Text)
			}
		})
		return core.Overlay{
			AnchorBounds: func() core.Bounds {
				at := s.pointer.Get()
				if s.pointerKnown {
					return core.Bounds{Origin: at, Size: core.Size{Width: 1, Height: 1}}
				}
				box := s.value.Get().Bounds
				area, _ := s.area.Bounds()
				return core.Bounds{Origin: core.Point{X: area.Origin.X + box.Origin.X + box.Size.Width,
					Y: area.Origin.Y + box.Origin.Y + box.Size.Height}, Size: core.Size{Width: 1, Height: 1}}
			},
			Placement: core.PlaceBottom, Align: core.AlignStart, Offset: 8, Margin: 8,
			OnCancel: s.clear, OnPressOutside: func(core.Point) {
				if !s.menuOpen.GetUntracked() {
					s.clear()
				}
			},
			OnMouseEnter: func(core.MouseEvent) { s.overAction = true },
			OnMouseLeave: func(core.MouseEvent) {
				s.overAction = false
				if s.cleared {
					s.clear()
				}
			},
			Style: core.Style{CornerRadius: ui.RadiusControl,
				Background: ui.Alpha(colors.Surface(), 1), BorderWidth: 1, BorderColor: colors.Border(),
				Shadows: []core.BoxShadow{ui.Shadow(0, 4, 14, 0, ui.Black(0.12))}},
			Children: []core.Node{ui.Button{Text: apptext.T("翻译选中文字"), Icon: lucide.Languages,
				Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "chat-selection-translate",
				OnPress: func() {
					text := s.value.GetUntracked().Text
					s.clear()
					a.openTranslationWith(text)
				}}},
		}
	}}
}
