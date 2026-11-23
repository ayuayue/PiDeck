//go:build !js && !android && !ios

package workbench

// The audio a preview plays: one player for the dialog that is open, made as
// an audio file opens in it and closed as it closes, so nothing keeps playing
// behind a closed dialog.

import (
	"fmt"
	"time"

	"github.com/nsgo-dev/nsgo/audio"
	"github.com/nsgo-dev/nsgo/core"
)

// previewPlayer is the player of the preview on screen. Its state is the
// core's; the signals are what the platform last reported.
type previewPlayer struct {
	player   *audio.Player
	playing  *core.Signal[bool]
	position *core.Signal[time.Duration]
	duration *core.Signal[time.Duration]
	err      *core.Signal[string]
}

// openPreviewAudio makes the player of an audio file. Nothing plays until
// the user asks for it.
func (a *app) openPreviewAudio(path string) {
	sound := &previewPlayer{
		playing:  core.NewSignal(a.cx, false),
		position: core.NewSignal(a.cx, time.Duration(0)),
		duration: core.NewSignal(a.cx, time.Duration(0)),
		err:      core.NewSignal(a.cx, ""),
	}
	sound.player = audio.NewPlayer(a.cx, audio.Source{URI: fileURL(path)}, audio.PlayerOptions{
		OnLoad: func(duration time.Duration) { sound.duration.Set(duration) },
		OnProgress: func(position, duration time.Duration) {
			sound.position.Set(position)
			if duration > 0 {
				sound.duration.Set(duration)
			}
		},
		OnEnd: func() {
			sound.playing.Set(false)
			sound.position.Set(0)
		},
		OnError: func(err error) {
			sound.err.Set(err.Error())
			sound.playing.Set(false)
		},
	})
	a.previewAudio = sound
}

// closePreviewAudio stops and forgets the player.
func (a *app) closePreviewAudio() {
	if a.previewAudio == nil {
		return
	}
	a.previewAudio.player.Close()
	a.previewAudio = nil
}

// toggle plays or pauses the file.
func (s *previewPlayer) toggle() {
	if s.player == nil {
		return
	}
	if s.player.State() == audio.PlayerPlaying {
		s.player.Pause()
		s.playing.Set(false)
		return
	}
	s.err.Set("")
	s.playing.Set(true)
	s.player.Play(func(err error) {
		if err != nil {
			s.err.Set(err.Error())
			s.playing.Set(false)
		}
	})
}

// seekSeconds moves the playback to a second of the file, as the progress
// slider asks.
func (s *previewPlayer) seekSeconds(seconds float64) {
	if s.player == nil || seconds < 0 {
		return
	}
	at := time.Duration(seconds * float64(time.Second))
	s.position.Set(at)
	s.player.Seek(at)
}

// clockText says a position as a player does: 1:05, an hour and more with
// the hour.
func clockText(at time.Duration) string {
	total := max(int(at/time.Second), 0)
	if total >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", total/3600, total/60%60, total%60)
	}
	return fmt.Sprintf("%d:%02d", total/60, total%60)
}
