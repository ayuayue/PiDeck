//go:build !js && !android && !ios

package workbench

// Notification sounds: when a turn finishes, fails or waits for an answer,
// the desktop plays a short sound the settings choose. The sounds ship
// with the app, and one imported file can take their place.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck-v2/internal/alerts"
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// What importing a sound refuses, said to the user where it happened.
var (
	errAlertSoundSize = errors.New("alert sound: size")
	errAlertSoundType = errors.New("alert sound: type")
)

const (
	// alertCustom is the choice that plays the imported file.
	alertCustom = "custom"
	// alertSoundDir holds it in the app's data directory, and
	// maxAlertSound is the size a file may reach before the app refuses
	// it: the platforms decode 8 MiB, and an alert has no business being
	// long.
	alertSoundDir = "sounds"
	maxAlertSound = 2 << 20
	// defaultAlertVolume is the percent a config without a volume plays at.
	defaultAlertVolume = 70
)

// alertSoundTypes are the files the picker offers; the platforms decode
// these formats.
var alertSoundTypes = []string{".wav", ".mp3", ".m4a", ".aac"}

// alertChoice is the sound a moment plays as the config names it, "" for
// the moment's default.
func (a *app) alertChoice(kind string) string {
	switch kind {
	case alerts.KindError:
		return a.cfg.SoundError
	case alerts.KindWaiting:
		return a.cfg.SoundWaiting
	default:
		return a.cfg.SoundDone
	}
}

// alertVolume is the configured volume, 0 to 1; a config without one plays
// at defaultAlertVolume.
func (a *app) alertVolume() float32 {
	pct := defaultAlertVolume
	if a.cfg.SoundVolume != nil {
		pct = *a.cfg.SoundVolume
	}
	if pct <= 0 {
		return 0
	}
	return float32(min(100, pct)) / 100
}

// alertAllowed says whether this moment plays a sound at all: the switch
// is on, and either the window is hidden or the settings do not ask for
// that.
func (a *app) alertAllowed() bool {
	if !a.cfg.SoundEnabled {
		return false
	}
	if a.cfg.SoundOnlyHidden {
		if w := a.window(); w != nil && w.Visible() {
			return false
		}
	}
	return true
}

// playAlert sounds a moment, as the settings choose. It runs on the UI
// thread: the player and NSGo's audio calls belong to the engine's
// goroutine, and the imported file's bytes are kept in memory so nothing
// reads the disk here.
func (a *app) playAlert(kind string) {
	if !a.alertAllowed() {
		return
	}
	a.soundAlert(kind)
}

// soundAlert plays a moment without the switch, for the settings' own
// preview: the user asked to hear it.
func (a *app) soundAlert(kind string) {
	if a.sounds == nil {
		return
	}
	volume := a.alertVolume()
	if volume <= 0 {
		return
	}
	name, data := alertSource(kind, a.alertChoice(kind), a.customSound)
	if name == alertCustom {
		a.sounds.PlayData(alertCustom, data, volume)
		return
	}
	a.sounds.Play(name, volume)
}

// alertSource is what a moment plays: the imported file when it is chosen
// and present, a named built-in, or the moment's own default when the
// choice is empty or names nothing the app knows.
func alertSource(kind, choice string, custom []byte) (string, []byte) {
	if choice == alertCustom {
		if len(custom) > 0 {
			return alertCustom, custom
		}
		// The file went missing since it was imported: the moment's own
		// sound is better than silence.
		choice = ""
	}
	if _, ok := alerts.Data(choice); ok {
		return choice, nil
	}
	return alerts.Default(kind), nil
}

// loadCustomSound reads the imported file, if the config names one, so an
// alert plays its bytes instead of touching the disk on the UI thread.
// A file that cannot be read is dropped from the config rather than
// blocking startup.
func (a *app) loadCustomSound() {
	a.customSound = nil
	a.customSoundFor = ""
	name := strings.TrimSpace(a.cfg.SoundCustom)
	if name == "" || a.dataDir == "" {
		return
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, alertSoundDir, filepath.Base(name)))
	if err != nil || len(data) == 0 || len(data) > maxAlertSound {
		a.cfg.SoundCustom = ""
		if a.st != nil {
			a.st.edit(func(c *config) { c.SoundCustom = "" })
		}
		return
	}
	a.customSound = data
	a.customSoundFor = name
}

// pickAlertSound asks for an audio file and imports it, then leaves the
// choice to the sound rows: the imported file replaces the one before it.
func (a *app) pickAlertSound() {
	a.cx.PickFiles(core.PickFilesOptions{Types: alertSoundTypes, Limit: 1,
		Title: apptext.T("选择提示音"), TypesName: apptext.T("音频")}, func(files []core.File, err error) {
		if err != nil {
			a.toast(ui.ToastError, "选择提示音失败", err.Error())
			return
		}
		if len(files) == 0 || files[0].Path == "" {
			return
		}
		path := files[0].Path
		go func() {
			name, data, err := importAlertSound(a.dataDir, path)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "提示音没能导入", alertImportError(err))
					return
				}
				a.customSound, a.customSoundFor = data, name
				if a.sounds != nil {
					a.sounds.Forget(alertCustom)
				}
				a.updateGeneralSettings(func(c *config) { c.SoundCustom = name })
				a.toast(ui.ToastSuccess, "提示音已导入", "在完成、出错或等待确认里选择“自定义”。")
			})
		}()
	})
}

// importAlertSound copies a file into the data directory's sounds folder,
// writes it whole or not at all, and returns its name and bytes.
func importAlertSound(dataDir, path string) (string, []byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", nil, err
	}
	if info.Size() <= 0 || info.Size() > maxAlertSound {
		return "", nil, errAlertSoundSize
	}
	ext := strings.ToLower(filepath.Ext(path))
	if !containsString(alertSoundTypes, ext) {
		return "", nil, errAlertSoundType
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	if len(data) > maxAlertSound {
		return "", nil, errAlertSoundSize
	}
	dir := filepath.Join(dataDir, alertSoundDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", nil, err
	}
	name := alertCustom + ext
	tmp := filepath.Join(dir, name+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", nil, err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		_ = os.Remove(tmp)
		return "", nil, err
	}
	// One custom sound at a time: an earlier import with another
	// extension would otherwise linger.
	entries, err := os.ReadDir(dir)
	if err == nil {
		for _, entry := range entries {
			base := entry.Name()
			if base != name && strings.HasPrefix(base, alertCustom+".") {
				_ = os.Remove(filepath.Join(dir, base))
			}
		}
	}
	return name, data, nil
}

// clearAlertSound forgets the imported file and the rows that chose it.
func (a *app) clearAlertSound() {
	a.customSound, a.customSoundFor = nil, ""
	a.updateGeneralSettings(func(c *config) {
		c.SoundCustom = ""
		for _, choice := range []*string{&c.SoundDone, &c.SoundError, &c.SoundWaiting} {
			if *choice == alertCustom {
				*choice = ""
			}
		}
	})
	if a.sounds != nil {
		a.sounds.Forget(alertCustom)
	}
	_ = os.RemoveAll(filepath.Join(a.dataDir, alertSoundDir))
}

// setAlertKind stores which sound a moment plays.
func (a *app) setAlertKind(kind, name string) {
	switch kind {
	case alerts.KindError:
		a.cfg.SoundError = name
		a.st.change(func(c *config) { c.SoundError = name })
	case alerts.KindWaiting:
		a.cfg.SoundWaiting = name
		a.st.change(func(c *config) { c.SoundWaiting = name })
	default:
		a.cfg.SoundDone = name
		a.st.change(func(c *config) { c.SoundDone = name })
	}
	a.saveConfigAsync()
	a.bumpSettings()
}

// setAlertVolume stores the volume the slider rests at, as a percentage.
// The signal carries it to the row at once; only the file write waits for
// the drag to rest.
func (a *app) setAlertVolume(pct int) {
	pct = min(100, max(0, pct))
	a.cfg.SoundVolume = &pct
	if a.alertVolumeSig != nil {
		a.alertVolumeSig.Set(pct)
	}
	a.alertVolumeSeq++
	seq := a.alertVolumeSeq
	if a.st == nil {
		return
	}
	a.st.change(func(c *config) { v := pct; c.SoundVolume = &v })
	a.cx.AfterFunc(300*time.Millisecond, func() {
		if a.alertVolumeSeq != seq || a.st == nil {
			return // still moving: the last value will be kept
		}
		a.saveConfigAsync()
	})
}

// alertVolumePct is the slider's reading: the volume the drag set, else the
// configured percentage, else the default.
func (a *app) alertVolumePct() int {
	if a.alertVolumeSig != nil {
		return a.alertVolumeSig.Get()
	}
	return a.configuredAlertVolumePct()
}

// configuredAlertVolumePct is the volume the config holds, for a test that
// builds the app without its signals.
func (a *app) configuredAlertVolumePct() int {
	if a.cfg.SoundVolume != nil {
		return min(100, max(0, *a.cfg.SoundVolume))
	}
	return defaultAlertVolume
}

// alertSoundChoices are the choices the three sound rows offer: the moment's
// default, the sounds the app ships, and the imported file once there is
// one.
func (a *app) alertSoundChoices() []choice[string] {
	options := []choice[string]{{"", "默认"}}
	for _, name := range alerts.Names() {
		options = append(options, choice[string]{name, alertSoundLabel(name)})
	}
	if a.cfg.SoundCustom != "" {
		options = append(options, choice[string]{alertCustom, "自定义"})
	}
	return options
}

// alertSoundLabel names a built-in sound for the picker.
func alertSoundLabel(name string) string {
	switch name {
	case alerts.NameBell:
		return "钟声"
	case alerts.NamePop:
		return "气泡"
	case alerts.NameBuzz:
		return "蜂鸣"
	default:
		return "清铃"
	}
}

// alertImportError says why an import was refused, in the user's language.
func alertImportError(err error) string {
	switch {
	case errors.Is(err, errAlertSoundSize):
		return apptext.T("文件为空或超过 2 MB。")
	case errors.Is(err, errAlertSoundType):
		return apptext.T("只支持 wav、mp3、m4a 和 aac。")
	default:
		return err.Error()
	}
}

// containsString reports whether list holds s.
func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
