// Package alerts plays the app's short notification sounds on both hosts.
//
// A sound is decoded once, kept for the life of the scope, and played any
// number of times; the bytes come from the embedded assets, or from a file
// the desktop copied into its data directory. The package owns what a kind
// sounds like by default, not when it plays: the workbench alerts when a
// turn ends and when an agent waits for an answer, the phone when its poll
// sees the same change.
//
// A Player and the NSGo audio calls under it belong to the engine's
// goroutine, so call them from handlers and UI-thread work, never from a
// background goroutine without core.Scope.Post.
package alerts

import (
	"example.com/pideck/assets"
	"github.com/nsgo-dev/nsgo/audio"
	"github.com/nsgo-dev/nsgo/core"
)

// The moments that have a sound of their own.
const (
	KindDone    = "done"
	KindError   = "error"
	KindWaiting = "waiting"
)

// The sounds the app ships. The names are stable: they are what a config
// file and the phone's saved settings hold.
const (
	NameChime = "chime"
	NameBell  = "bell"
	NamePop   = "pop"
	NameBuzz  = "buzz"
)

// builtins maps a name to the bytes the platforms decode.
var builtins = map[string][]byte{
	NameChime: assets.SoundChime,
	NameBell:  assets.SoundBell,
	NamePop:   assets.SoundPop,
	NameBuzz:  assets.SoundBuzz,
}

// order is how a picker lists them, quietest last.
var order = []string{NameChime, NameBell, NamePop, NameBuzz}

// Names lists the built-in sounds in the order a picker shows them.
func Names() []string {
	return append([]string(nil), order...)
}

// Data returns a built-in sound's bytes.
func Data(name string) ([]byte, bool) {
	data, ok := builtins[name]
	return data, ok
}

// Default is the sound a kind plays when the setting names none.
func Default(kind string) string {
	switch kind {
	case KindError:
		return NameBuzz
	case KindWaiting:
		return NameBell
	default:
		return NameChime
	}
}

// Player keeps decoded sounds and plays them at a volume.
type Player struct {
	cx      *core.Scope
	sounds  map[string]*audio.Sound
	loading map[string]bool
}

// New makes a player for the scope; it decodes nothing until a play.
func New(cx *core.Scope) *Player {
	return &Player{cx: cx, sounds: map[string]*audio.Sound{}, loading: map[string]bool{}}
}

// Play plays a built-in sound at volume, from 0 to 1. A first play decodes
// it and the sound arrives a turn later; later plays start at once.
func (p *Player) Play(name string, volume float32) {
	data, ok := builtins[name]
	if !ok {
		return
	}
	p.play(name, data, volume)
}

// PlayData plays bytes kept under key, for a sound the user brought in.
// The same bytes under the same key are decoded once.
func (p *Player) PlayData(key string, data []byte, volume float32) {
	if len(data) == 0 {
		return
	}
	p.play(key, data, volume)
}

// Forget drops a sound, so an imported file the user replaced is decoded
// again rather than played from the old bytes.
func (p *Player) Forget(key string) {
	if s := p.sounds[key]; s != nil {
		s.Close()
		delete(p.sounds, key)
	}
	delete(p.loading, key)
}

func (p *Player) play(key string, data []byte, volume float32) {
	if p == nil || p.cx == nil || volume <= 0 || len(data) == 0 {
		return
	}
	if s := p.sounds[key]; s != nil {
		s.Play(audio.Voice{Volume: volume})
		return
	}
	if p.loading[key] {
		// The first play is still decoding: one playback is the point,
		// not a burst when it arrives.
		return
	}
	p.loading[key] = true
	audio.LoadSound(p.cx, audio.Source{Data: data}, func(s *audio.Sound, err error) {
		delete(p.loading, key)
		if err != nil || s == nil {
			return
		}
		p.sounds[key] = s
		s.Play(audio.Voice{Volume: volume})
	})
}
