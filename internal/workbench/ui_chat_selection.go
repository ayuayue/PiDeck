//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// chatSelection belongs to the mounted transcript, not the stored session.
// Updating it only moves the action; it never rebuilds the selected text.
type chatSelection struct {
	value *core.Signal[core.TextSelection]
	area  core.Ref
	// Native desktops clear a selection when the action is pressed. Keep
	// its snapshot while the pointer is over the action, until activation
	// or leaving it, so clearing on mouse-down cannot eat the click.
	overAction, cleared bool
	size                core.Size
}

func newChatSelection(cx *core.Scope) *chatSelection {
	return &chatSelection{value: core.NewSignal(cx, core.TextSelection{})}
}

func (s *chatSelection) clear() {
	s.overAction, s.cleared = false, false
	s.value.Set(core.TextSelection{})
}

func (s *chatSelection) changed(selection core.TextSelection) {
	if strings.TrimSpace(selection.Text) == "" || selection.Bounds.Size.Width <= 0 || selection.Bounds.Size.Height <= 0 {
		// Native text selection clears on mouse-down, before the action's
		// press arrives. Keep the snapshot for that short hand-off; the
		// overlay's outside/cancel/leave handlers clear it for real exits.
		s.cleared = true
		return
	}
	s.cleared = false
	s.value.Set(selection)
}

func (s *chatSelection) resized(bounds core.Bounds) {
	if s.size != bounds.Size {
		s.size = bounds.Size
		s.clear()
	}
}

func (a *app) chatSelectionAction(s *chatSelection) core.Node {
	return core.Show{When: func() bool { return s.value.Get().Text != "" }, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.Overlay{
			AnchorBounds: func() core.Bounds {
				box := s.value.Get().Bounds
				area, _ := s.area.Bounds()
				box.Origin.X += area.Origin.X
				box.Origin.Y += area.Origin.Y
				return box
			},
			Placement: core.PlaceLeft, Align: core.AlignStart, Offset: 8, Margin: 8,
			OnCancel: s.clear, OnPressOutside: func(core.Point) { s.clear() },
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
