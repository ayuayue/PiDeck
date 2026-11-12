package main

// PiDeck's palette, rebuilt for NSGo's theme: paper and ink in light, the
// same paper inverted in dark, color only where it means something.

import (
	"time"

	"github.com/oneo-me/nsgo/core"
)

// The tones, from DESIGN.md.
var (
	ink      = core.RGB(0x18181b)
	inkDeep  = core.RGB(0x09090b)
	charcoal = core.RGB(0x202124)
	graphite = core.RGB(0x666666)
	mist     = core.RGB(0x9a9a9a)
	railGray = core.RGB(0xf0f0f0)
	ashGray  = core.RGB(0xf4f4f4)
	hair     = core.RGBA(0x0d0d0d, 0.13)
	hairSoft = core.RGBA(0x0d0d0d, 0.08)
	danger   = core.RGB(0xb42318)
	success  = core.RGB(0x14703a)
	warning  = core.RGB(0x854d0e)
	thinking = core.RGB(0x6366f1)
)

// pideckTheme is the app's look in both appearances.
func pideckTheme() *core.Theme {
	t := &core.Theme{Radius: 8}

	t.Light = core.Palette{
		Background:     core.RGB(0xffffff),
		Surface:        core.RGB(0xffffff),
		SurfaceHover:   core.RGBA(0x0d0d0d, 0.055),
		SurfacePressed: core.RGBA(0x0d0d0d, 0.10),
		Border:         hair,
		Text:           ink,
		TextMuted:      graphite,
		Accent:         ink,
		AccentHover:    core.RGB(0x3f3f46),
		AccentPressed:  inkDeep,
		AccentText:     core.RGB(0xffffff),
		Danger:         danger,
		Warning:        warning,
		Success:        success,
		Selection:      core.RGBA(0x18181b, 0.14),
		Focus:          core.RGBA(0x18181b, 0.38),
		Scrollbar:      core.RGBA(0x0d0d0d, 0.22),
	}
	t.Dark = core.Palette{
		Background:     core.RGB(0x121212),
		Surface:        core.RGB(0x1a1a1a),
		SurfaceHover:   core.RGBA(0xffffff, 0.06),
		SurfacePressed: core.RGBA(0xffffff, 0.11),
		Border:         core.RGBA(0xffffff, 0.13),
		Text:           core.RGB(0xededed),
		TextMuted:      core.RGB(0xa1a1a1),
		Accent:         core.RGB(0xe7e7e7),
		AccentHover:    core.RGB(0xffffff),
		AccentPressed:  core.RGB(0xd0d0d0),
		AccentText:     core.RGB(0x121212),
		Danger:         core.RGB(0xf0958f),
		Warning:        core.RGB(0xe6b567),
		Success:        core.RGB(0x79bea1),
		Selection:      core.RGBA(0xffffff, 0.18),
		Focus:          core.RGBA(0xffffff, 0.45),
		Scrollbar:      core.RGBA(0xffffff, 0.24),
	}

	light := map[string]core.Color{
		"inset":       railGray,
		"raised":      core.RGB(0xffffff),
		"field":       core.RGB(0xfbfbfb),
		"fieldBorder": hair,
		"line":        hairSoft,
		"faint":       mist,
		"accentFill":  ink,
		"light":       ink,
		"onLight":     core.RGB(0xffffff),
		"track":       core.RGBA(0x0d0d0d, 0.16),
		"knob":        core.RGB(0xffffff),
		"code":        core.RGB(0x373737),
		"info":        core.RGB(0x1d4ed8),
		"down":        danger,
	}
	dark := map[string]core.Color{
		"inset":       core.RGB(0x1b1b1b),
		"raised":      core.RGB(0x262626),
		"field":       core.RGB(0x171717),
		"fieldBorder": core.RGBA(0xffffff, 0.14),
		"line":        core.RGBA(0xffffff, 0.08),
		"faint":       core.RGB(0x6f6f6f),
		"accentFill":  core.RGB(0xe7e7e7),
		"light":       core.RGB(0xe7e7e7),
		"onLight":     core.RGB(0x121212),
		"track":       core.RGBA(0xffffff, 0.20),
		"knob":        core.RGB(0xfafafa),
		"code":        core.RGB(0xd6d6d6),
		"info":        core.RGB(0x7aa2ff),
		"down":        core.RGB(0xf0958f),
	}
	for name, c := range light {
		t.Light.SetColor(name, c)
	}
	for name, c := range dark {
		t.Dark.SetColor(name, c)
	}
	t.Tokens = map[string]string{"font-sans": "", "font-mono": ""}
	return t
}

// pressMotion eases the fill, edge and small transforms of the app's own
// pressable rows between their resting, hover and pressed states.
var pressMotion = core.Transition{Duration: 120 * time.Millisecond, Easing: core.EaseOut,
	Properties: core.TransitionBackground | core.TransitionBorder | core.TransitionTransform | core.TransitionOpacity}
