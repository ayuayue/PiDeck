package viewkit

// PiDeck's palette, rebuilt for NSGo's theme: paper and ink in light, the
// same paper inverted in dark, color only where it means something.

import (
	"runtime"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// Neutral tones from PiDeck's foundation.css.
var (
	ink      = core.RGB(0x202124)
	inkDeep  = core.RGB(0x09090b)
	graphite = core.RGB(0x666666)
	mist     = core.RGB(0x9a9a9a)
	railGray = core.RGB(0xf0f0f0)
	hairline = core.RGBA(0x0d0d0d, 0.13)
	softLine = core.RGBA(0x0d0d0d, 0.08)
	danger   = core.RGB(0xb42318)
	success  = core.RGB(0x14703a)
	warning  = core.RGB(0x854d0e)

	// Thinking and Warning are read by both application hosts.
	Thinking = core.RGB(0x6366f1)
	Warning  = warning

	// Idle and Working are a session's status dot: blue once its agent is
	// up with no turn in flight, amber while a turn (or an approval) is.
	// Both hosts read them, as they do Thinking.
	Idle    = core.RGB(0x6366f1)
	Working = core.RGB(0xd99524)
)

// pideckTheme is the app's look in both appearances.
func Theme() *core.Theme {
	sans := SansFamily
	if runtime.GOOS == "windows" {
		// This SDK's DirectWrite adapter resolves one installed family,
		// not a per-glyph CSS cascade. Start with a UI face covering CJK
		// so Chinese body text does not fall through Segoe UI to SimSun.
		sans = `"Microsoft YaHei UI", "Microsoft YaHei", ` + sans
	}
	t := &core.Theme{Radius: 8, Sans: sans, Mono: MonoStack}

	t.Light = core.Palette{
		Background:     core.RGB(0xffffff),
		Surface:        core.RGB(0xffffff),
		SurfaceHover:   core.RGBA(0x0d0d0d, 0.055),
		SurfacePressed: core.RGBA(0x0d0d0d, 0.10),
		Border:         hairline,
		Text:           ink,
		TextMuted:      graphite,
		Accent:         core.RGB(0x18181b),
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
		Text:           core.RGB(0xecece7),
		TextMuted:      core.RGB(0x9a9a94),
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
		"fieldBorder": hairline,
		"line":        softLine,
		"faint":       mist,
		"accentFill":  core.RGB(0x18181b),
		"light":       core.RGB(0x18181b),
		"onLight":     core.RGB(0xffffff),
		"track":       core.RGBA(0x0d0d0d, 0.16),
		"knob":        core.RGB(0xffffff),
		"code":        core.RGB(0x373737),
		"info":        core.RGB(0x1d4ed8),
		"thinking":    Thinking,
		"down":        danger,
	}
	dark := map[string]core.Color{
		"inset":       core.RGB(0x1b1b1b),
		"raised":      core.RGB(0x262626),
		"field":       core.RGB(0x171717),
		"fieldBorder": core.RGBA(0xffffff, 0.14),
		"line":        core.RGBA(0xffffff, 0.08),
		"faint":       core.RGB(0xa0a09a),
		"accentFill":  core.RGB(0xe7e7e7),
		"light":       core.RGB(0xe7e7e7),
		"onLight":     core.RGB(0x121212),
		"track":       core.RGBA(0xffffff, 0.20),
		"knob":        core.RGB(0xfafafa),
		"code":        core.RGB(0xd6d6d6),
		"info":        core.RGB(0x7aa2ff),
		"thinking":    core.RGB(0x818cf8),
		"down":        core.RGB(0xf0958f),
	}
	for name, c := range light {
		t.Light.SetColor(name, c)
	}
	for name, c := range dark {
		t.Dark.SetColor(name, c)
	}
	t.Tokens = map[string]string{}
	return t
}

// pressMotion eases the fill, edge and small transforms of the app's own
// pressable rows between their resting, hover and pressed states.
var PressMotion = core.Transition{Duration: 120 * time.Millisecond, Easing: core.EaseOut,
	Properties: core.TransitionBackground | core.TransitionBorder | core.TransitionTransform | core.TransitionOpacity}
