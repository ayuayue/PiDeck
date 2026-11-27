package viewkit

// PiDeck's foundation: neutral white and gray, with an independently
// tuned charcoal appearance. Both native hosts share these role colors.

import (
	"runtime"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// Control rims, internal rules and region edges stay separate so nested
// panels do not acquire the weight of an outer boundary.
var (
	ink      = core.RGB(0x242424)
	inkDeep  = core.RGB(0x111111)
	graphite = core.RGB(0x555555)
	mist     = core.RGB(0x5c5c5c)
	railGray = core.RGB(0xeeeeee)
	hairline = core.RGB(0xcecece)
	softLine = core.RGB(0xe3e3e3)
	edge     = core.RGBA(0x242424, 0.16)
	edgeDark = core.RGBA(0xe9e9e9, 0.16)
	softDark = core.RGB(0x353535)
	danger   = core.RGB(0xa33c36)
	success  = core.RGB(0x35684c)
	warning  = core.RGB(0x7c5b20)

	// Thinking and Warning are read by both application hosts.
	Thinking = core.RGB(0x65518a)
	Warning  = warning

	// Idle and Working are the session status dots: teal when ready,
	// amber while a turn or an approval is in flight.
	Idle    = core.RGB(0x2d607b)
	Working = core.RGB(0xb88732)
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
		Background:     core.RGB(0xf7f7f7),
		Surface:        core.RGB(0xffffff),
		SurfaceHover:   core.RGB(0xe9e9e9),
		SurfacePressed: core.RGB(0xdedede),
		Border:         hairline,
		Text:           ink,
		TextMuted:      graphite,
		Accent:         core.RGB(0x363636),
		AccentHover:    ink,
		AccentPressed:  inkDeep,
		AccentText:     core.RGB(0xffffff),
		Danger:         danger,
		Warning:        warning,
		Success:        success,
		Selection:      core.RGBA(0x363636, 0.18),
		Focus:          core.RGB(0x363636),
		Scrollbar:      core.RGBA(0x242424, 0.48),
	}
	t.Dark = core.Palette{
		Background:     core.RGB(0x191919),
		Surface:        core.RGB(0x242424),
		SurfaceHover:   core.RGB(0x343434),
		SurfacePressed: core.RGB(0x414141),
		Border:         core.RGB(0x515151),
		Text:           core.RGB(0xe9e9e9),
		TextMuted:      core.RGB(0xc6c6c6),
		Accent:         core.RGB(0xdedede),
		AccentHover:    core.RGB(0xf4f4f4),
		AccentPressed:  core.RGB(0xc4c4c4),
		AccentText:     core.RGB(0x202020),
		Danger:         core.RGB(0xf0aaa3),
		Warning:        core.RGB(0xe1c382),
		Success:        core.RGB(0x9ac9aa),
		Selection:      core.RGBA(0xdedede, 0.18),
		Focus:          core.RGB(0xdedede),
		Scrollbar:      core.RGBA(0xe9e9e9, 0.48),
	}

	light := map[string]core.Color{
		"inset":       railGray,
		"raised":      core.RGB(0xffffff),
		"field":       core.RGB(0xfbfbfb),
		"fieldBorder": core.RGBA(0x242424, 0.56),
		"line":        softLine,
		"edge":        edge,
		"faint":       mist,
		"accentFill":  core.RGB(0x363636),
		"light":       ink,
		"onLight":     core.RGB(0xf7f7f7),
		"track":       core.RGBA(0x242424, 0.48),
		"knob":        core.RGB(0xffffff),
		"code":        core.RGB(0x3e3e3e),
		"info":        core.RGB(0x2d607b),
		"thinking":    Thinking,
		"down":        danger,
	}
	dark := map[string]core.Color{
		"inset":       core.RGB(0x121212),
		"raised":      core.RGB(0x2d2d2d),
		"field":       core.RGB(0x1e1e1e),
		"fieldBorder": core.RGBA(0xe9e9e9, 0.56),
		"line":        softDark,
		"edge":        edgeDark,
		"faint":       core.RGB(0xb5b5b5),
		"accentFill":  core.RGB(0xdedede),
		"light":       core.RGB(0xe9e9e9),
		"onLight":     core.RGB(0x191919),
		"track":       core.RGBA(0xe9e9e9, 0.48),
		"knob":        core.RGB(0x202020),
		"code":        core.RGB(0xd6d6d6),
		"info":        core.RGB(0x9fc6e1),
		"thinking":    core.RGB(0xc4b7e1),
		"down":        core.RGB(0xf0aaa3),
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
