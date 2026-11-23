//go:build !js && !android && !ios

package workbench

// The alert settings decide whether a moment plays, how loud, and what;
// importing a sound decides what a "custom" choice plays later.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck-v2/internal/alerts"
	"github.com/nsgo-dev/nsgo/core"
)

func TestAlertSourceFallsBack(t *testing.T) {
	if got, _ := alertSource(alerts.KindDone, "pop", nil); got != "pop" {
		t.Fatalf("done = %q, want the configured pop", got)
	}
	if got, _ := alertSource(alerts.KindError, "no-such-sound", nil); got != alerts.NameBuzz {
		t.Fatalf("error = %q, want buzz for an unknown name", got)
	}
	// Custom with no imported bytes falls back to the moment's own sound.
	if got, _ := alertSource(alerts.KindWaiting, alertCustom, nil); got != alerts.NameBell {
		t.Fatalf("waiting = %q, want bell when no file was imported", got)
	}
	if got, data := alertSource(alerts.KindWaiting, alertCustom, []byte("RIFF")); got != alertCustom || string(data) != "RIFF" {
		t.Fatalf("waiting = %q %q, want the imported file", got, data)
	}
}

func TestAlertSoundChoice(t *testing.T) {
	built := &app{cfg: config{SoundDone: "pop", SoundError: "", SoundWaiting: alertCustom}}
	if got := built.alertChoice(alerts.KindDone); got != "pop" {
		t.Fatalf("done = %q", got)
	}
	if got := built.alertChoice(alerts.KindError); got != "" {
		t.Fatalf("error = %q, want the moment's default", got)
	}
	if got := built.alertChoice(alerts.KindWaiting); got != alertCustom {
		t.Fatalf("waiting = %q", got)
	}
}

func TestAlertVolume(t *testing.T) {
	built := &app{}
	if got := built.alertVolume(); got != 0.7 {
		t.Fatalf("default volume = %v, want 0.7", got)
	}
	zero := 0
	built.cfg.SoundVolume = &zero
	if got := built.alertVolume(); got != 0 {
		t.Fatalf("zero volume = %v, want silence", got)
	}
	loud := 150
	built.cfg.SoundVolume = &loud
	if got := built.alertVolume(); got != 1 {
		t.Fatalf("volume = %v, want it clamped to 1", got)
	}
}

func TestAlertAllowed(t *testing.T) {
	built := &app{}
	if built.alertAllowed() {
		t.Fatal("a config with sounds off must not play")
	}
	built.cfg.SoundEnabled = true
	if !built.alertAllowed() {
		t.Fatal("an enabled config plays")
	}
}

func TestImportAlertSound(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(t.TempDir(), "my chime.wav")
	if err := os.WriteFile(src, []byte("RIFF0000WAVE"), 0o644); err != nil {
		t.Fatal(err)
	}
	name, data, err := importAlertSound(dir, src)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if name != "custom.wav" || string(data) != "RIFF0000WAVE" {
		t.Fatalf("import = %q %q", name, data)
	}
	kept, err := os.ReadFile(filepath.Join(dir, alertSoundDir, name))
	if err != nil || string(kept) != "RIFF0000WAVE" {
		t.Fatalf("stored file = %q, %v", kept, err)
	}

	// A second import with another extension replaces the first.
	other := filepath.Join(t.TempDir(), "second.mp3")
	if err := os.WriteFile(other, []byte("ID3"), 0o644); err != nil {
		t.Fatal(err)
	}
	name, _, err = importAlertSound(dir, other)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if name != "custom.mp3" {
		t.Fatalf("second import = %q, want custom.mp3", name)
	}
	if _, err := os.Stat(filepath.Join(dir, alertSoundDir, "custom.wav")); !os.IsNotExist(err) {
		t.Fatalf("the earlier import is still there: %v", err)
	}

	text := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(text, []byte("not a sound"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := importAlertSound(dir, text); err != errAlertSoundType {
		t.Fatalf("text file import = %v, want errAlertSoundType", err)
	}
	big := filepath.Join(t.TempDir(), "big.wav")
	if err := os.WriteFile(big, make([]byte, maxAlertSound+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := importAlertSound(dir, big); err != errAlertSoundSize {
		t.Fatalf("oversize import = %v, want errAlertSoundSize", err)
	}
}

// TestAlertVolumeDragFollowsTheWholeMove keeps a drag on the volume slider
// from stopping after one step: the page used to rebuild on every change,
// so a long drag landed on one small step instead of following the finger.
func TestAlertVolumeDragFollowsTheWholeMove(t *testing.T) {
	built, screen, _ := newAskApp(t)
	built.settingsTab.Set("general")
	built.openSettingsPane()
	screen.Advance(200 * time.Millisecond)
	screen.WaitFor("id:sound-volume", 5*time.Second)
	screen.ScrollTo("id:settings-page", core.Point{Y: 600})
	screen.Advance(200 * time.Millisecond)

	before := built.alertVolumePct()
	path := make([]core.Point, 0, 12)
	for i := 1; i <= 12; i++ {
		path = append(path, core.Point{X: core.Points(-5 * i)})
	}
	screen.Drag("id:sound-volume-thumb", path...)
	screen.Advance(400 * time.Millisecond)

	got := built.alertVolumePct()
	if moved := before - got; moved < 5 {
		t.Fatalf("a %.0f-point drag moved the volume %d%% -> %d%% (%d points): the slider did not follow the finger",
			float64(-5*len(path)), before, got, moved)
	}
	if got < 0 || got > 100 {
		t.Fatalf("volume %d is outside 0-100 after the drag", got)
	}
	// The value the row shows is the one that will be played and kept.
	if played := int(built.alertVolume()*100 + 0.5); played != got {
		t.Fatalf("the row shows %d%% while playback uses %d%%", got, played)
	}
}
