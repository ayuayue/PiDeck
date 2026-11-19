package assets

import (
	_ "embed"
)

// The app's notification sounds, played by internal/alerts on both hosts.
// Each is a short mono WAV under a second, so a phone build pays about
// 180 KB for all four and no platform decodes more than it plays. Regenerate
// them with the generator described in the design notes; keep the formats
// the platforms share (WAV, AAC) and each file under NSGo's five seconds.

// SoundChime is the default sound of a finished turn: two bright notes.
//
//go:embed sounds/chime.wav
var SoundChime []byte

// SoundBell is the default sound of a turn waiting for an answer.
//
//go:embed sounds/bell.wav
var SoundBell []byte

// SoundPop is a short blip, the quietest of the four.
//
//go:embed sounds/pop.wav
var SoundPop []byte

// SoundBuzz is the default sound of a failed turn.
//
//go:embed sounds/buzz.wav
var SoundBuzz []byte
