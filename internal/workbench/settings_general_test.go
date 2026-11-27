//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"example.com/pideck-v2/internal/alerts"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// The exit path saves the store before a slider's debounce timer may fire.
func TestGeneralSliderUpdatesExitSnapshot(t *testing.T) {
	for _, kind := range []string{"chat", "tab", "volume"} {
		t.Run(kind, func(t *testing.T) {
			st, err := newStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(configWrites.Wait)
			var built *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				built = &app{cx: cx, st: st, cfg: st.config(),
					chatWidthPctSig: core.NewSignal(cx, chatWidthPctDefault),
					tabWidthPctSig:  core.NewSignal(cx, tabWidthPctDefault),
					alertVolumeSig:  core.NewSignal(cx, defaultAlertVolume)}
				return core.View{}
			})
			onNativeUI(t, screen, built, func() {
				switch kind {
				case "chat":
					built.setChatWidthPct(64)
				case "tab":
					built.setTabWidthPct(16)
				case "volume":
					built.setAlertVolume(37)
				}
			})
			// Save before advancing the debounce timer, just as quitting does.
			if err := st.save(); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(st.path)
			if err != nil {
				t.Fatal(err)
			}
			var saved config
			if err := json.Unmarshal(raw, &saved); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "chat":
				if saved.ChatWidthPct != 64 {
					t.Fatalf("exit saved chat width %d, want 64", saved.ChatWidthPct)
				}
			case "tab":
				if saved.TabWidthPct != 16 {
					t.Fatalf("exit saved tab width %d, want 16", saved.TabWidthPct)
				}
			case "volume":
				if saved.SoundVolume == nil || *saved.SoundVolume != 37 {
					t.Fatalf("exit did not save the latest volume: %+v", saved.SoundVolume)
				}
			}
		})
	}
}

func TestGeneralClearCustomSoundKeepsBuiltins(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(configWrites.Wait)
	cfg := st.config()
	cfg.SoundCustom, cfg.SoundDone = "custom.wav", alerts.NamePop
	cfg.SoundError, cfg.SoundWaiting = alertCustom, alerts.NameBell
	st.change(func(c *config) { *c = cfg })
	built := &app{st: st, cfg: cfg, dataDir: t.TempDir()}
	built.clearAlertSound()
	configWrites.Wait()
	saved := st.config()
	if saved.SoundCustom != "" || saved.SoundError != "" {
		t.Fatalf("custom selections were not cleared: %+v", saved)
	}
	if saved.SoundDone != alerts.NamePop || saved.SoundWaiting != alerts.NameBell {
		t.Fatalf("removing a custom file changed built-in choices: done=%q waiting=%q", saved.SoundDone, saved.SoundWaiting)
	}
	if built.cfg.SoundDone != saved.SoundDone || built.cfg.SoundWaiting != saved.SoundWaiting {
		t.Fatal("the UI and stored sound choices diverged")
	}
}

func TestGeneralWidthControlsAlign(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
	})
	for _, width := range []core.Points{1200, 900} {
		screen.Resize(width, 800)
		screen.WaitFor("id:chat-width", 5*time.Second)
		chat := screen.Find("id:chat-width").Bounds()
		tab := screen.Find("id:tab-width").Bounds()
		if chat.Origin.X != tab.Origin.X || chat.Size.Width != tab.Size.Width {
			t.Fatalf("sliders are not aligned at %v: chat=%+v tab=%+v", width, chat, tab)
		}
	}
}

func TestGeneralScanDependency(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
	})
	if !screen.FindMounted("id:scan-all").Props.Disabled {
		t.Fatal("scanning all projects must be unavailable while pi history is off")
	}
	onNativeUI(t, screen, built, func() {
		built.cfg.ScanPi = true
		built.bumpSettings()
	})
	screen.WaitUntil(5*time.Second, func() bool { return !screen.FindMounted("id:scan-all").Props.Disabled })
}

func TestGeneralLayoutReset(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
		built.setChatWidthPct(64)
		built.setTabWidthPct(12)
		built.updateGeneralSettings(func(c *config) { c.NotifyOnDone = false })
	})
	screen.Press("id:general-layout-reset")
	var chat, tab int
	var notify bool
	onNativeUI(t, screen, built, func() {
		chat, tab = built.chatWidthPct(), built.tabWidthPct()
		notify = built.cfg.NotifyOnDone
	})
	stored := built.st.config()
	if chat != chatWidthPctDefault || tab != tabWidthPctDefault || stored.ChatWidthPct != 0 || stored.TabWidthPct != 0 {
		t.Fatalf("layout defaults diverged: UI=%d/%d stored=%d/%d", chat, tab, stored.ChatWidthPct, stored.TabWidthPct)
	}
	if notify || stored.NotifyOnDone {
		t.Fatal("layout reset also changed a notification preference")
	}
}

func TestGeneralAlertDependencies(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
		built.cfg.NotifyOnDone, built.cfg.NotifyOnWaiting = false, false
		built.cfg.SoundEnabled = false
		built.setAlertVolume(0)
		built.bumpSettings()
	})
	for _, id := range []string{"notify-hidden", "sound-hidden", "sound-preview", "sound-preview-error", "sound-preview-waiting"} {
		if !screen.FindMounted("id:" + id).Props.Disabled {
			t.Fatalf("%s must be unavailable without its prerequisite", id)
		}
	}
	onNativeUI(t, screen, built, func() {
		built.cfg.NotifyOnWaiting = true
		built.setAlertVolume(40)
		built.bumpSettings()
	})
	for _, id := range []string{"notify-hidden", "sound-preview", "sound-preview-error", "sound-preview-waiting"} {
		if screen.FindMounted("id:" + id).Props.Disabled {
			t.Fatalf("%s must be available once its prerequisite is met", id)
		}
	}
	if !screen.FindMounted("id:sound-hidden").Props.Disabled {
		t.Fatal("previewing sound must not enable automatic playback")
	}
}

func TestGeneralSecurityFailureKeepsPreviousLevel(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	var before, after, stored string
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
		before = built.cfg.SecurityLevel
		built.dataDir = "" // Policy snapshot cannot be written.
	})
	page := screen.Find("id:settings-page").Bounds()
	control := screen.FindMounted("id:security-level").Bounds()
	screen.Scroll("id:settings-page", control.Origin.Y-page.Origin.Y-100)
	screen.Press("id:security-level")
	screen.Press("id:security-level-2")
	onNativeUI(t, screen, built, func() {
		after, stored = built.cfg.SecurityLevel, built.st.config().SecurityLevel
	})
	if after != before || stored != before {
		t.Fatalf("failed policy changed level: UI=%q stored=%q, want %q", after, stored, before)
	}
	screen.WaitFor(`id:security-level >> text:"安全门关闭"`, 5*time.Second)
}

func TestGeneralSettingsScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
	})
	screen.Resize(1200, 850)
	screen.WaitFor("id:chat-width", 5*time.Second)
	shot(screen, "general-redesign/top-light")
	screen.Scroll("id:settings-page", 550)
	shot(screen, "general-redesign/notifications-light")
	screen.Scroll("id:settings-page", 550)
	shot(screen, "general-redesign/sounds-light")
	onNativeUI(t, screen, built, func() {
		built.theme.Set("dark")
		built.applyTheme()
		built.forgetScrolls("settings")
	})
	screen.Resize(900, 720)
	shot(screen, "general-redesign/top-narrow-dark")
}
