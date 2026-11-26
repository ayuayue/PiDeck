package viewkit

// PiDeck's foundation: ink teal on cool paper, with an independently
// tuned charcoal appearance. Both native hosts share these role colors.

import (
	"runtime"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// Control rims, internal rules and region edges stay separate so nested
// panels do not acquire the weight of an outer boundary.
var (
	ink      = core.RGB(0x202c30)
	inkDeep  = core.RGB(0x193d42)
	graphite = core.RGB(0x506269)
	mist     = core.RGB(0x53666c)
	railGray = core.RGB(0xedf1f2)
	hairline = core.RGB(0xcbd5d8)
	softLine = core.RGB(0xe1e7e9)
	edge     = core.RGBA(0x202c30, 0.16)
	edgeDark = core.RGBA(0xe6eeef, 0.16)
	softDark = core.RGB(0x2c3a3f)
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
		Background:     core.RGB(0xf7f9f9),
		Surface:        core.RGB(0xffffff),
		SurfaceHover:   core.RGB(0xe6eef0),
		SurfacePressed: core.RGB(0xd5e2e5),
		Border:         hairline,
		Text:           ink,
		TextMuted:      graphite,
		Accent:         core.RGB(0x285d63),
		AccentHover:    core.RGB(0x214e53),
		AccentPressed:  inkDeep,
		AccentText:     core.RGB(0xffffff),
		Danger:         danger,
		Warning:        warning,
		Success:        success,
		Selection:      core.RGBA(0x285d63, 0.18),
		Focus:          core.RGB(0x285d63),
		Scrollbar:      core.RGBA(0x202c30, 0.48),
	}
	t.Dark = core.Palette{
		Background:     core.RGB(0x151b1d),
		Surface:        core.RGB(0x1d2528),
		SurfaceHover:   core.RGB(0x2a383c),
		SurfacePressed: core.RGB(0x34474b),
		Border:         core.RGB(0x3d5056),
		Text:           core.RGB(0xe6eeef),
		TextMuted:      core.RGB(0xbac9cb),
		Accent:         core.RGB(0x91c6cd),
		AccentHover:    core.RGB(0xaed8dc),
		AccentPressed:  core.RGB(0x7bb2ba),
		AccentText:     core.RGB(0x102428),
		Danger:         core.RGB(0xf0aaa3),
		Warning:        core.RGB(0xe1c382),
		Success:        core.RGB(0x9ac9aa),
		Selection:      core.RGBA(0x91c6cd, 0.18),
		Focus:          core.RGB(0x91c6cd),
		Scrollbar:      core.RGBA(0xe6eeef, 0.48),
	}

	light := map[string]core.Color{
		"inset":       railGray,
		"raised":      core.RGB(0xffffff),
		"field":       core.RGB(0xfbfdfd),
		"fieldBorder": core.RGBA(0x202c30, 0.56),
		"line":        softLine,
		"edge":        edge,
		"faint":       mist,
		"accentFill":  core.RGB(0x285d63),
		"light":       ink,
		"onLight":     core.RGB(0xf7f9f9),
		"track":       core.RGBA(0x202c30, 0.48),
		"knob":        core.RGB(0xffffff),
		"code":        core.RGB(0x2c4540),
		"info":        core.RGB(0x2d607b),
		"thinking":    Thinking,
		"down":        danger,
	}
	dark := map[string]core.Color{
		"inset":       core.RGB(0x101618),
		"raised":      core.RGB(0x263135),
		"field":       core.RGB(0x182023),
		"fieldBorder": core.RGBA(0xe6eeef, 0.56),
		"line":        softDark,
		"edge":        edgeDark,
		"faint":       core.RGB(0xa5b8bb),
		"accentFill":  core.RGB(0x91c6cd),
		"light":       core.RGB(0xe6eeef),
		"onLight":     core.RGB(0x151b1d),
		"track":       core.RGBA(0xe6eeef, 0.48),
		"knob":        core.RGB(0x102428),
		"code":        core.RGB(0xc5dde0),
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
