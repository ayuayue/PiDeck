package client

// The phone's alert: a short sound when the turn the phone is watching
// ends, or when the desktop waits for an answer. The setting belongs to
// this device, like its ring volume, so it is kept in remote.json rather
// than following the desktop's config.

import (
	"example.com/pideck/internal/alerts"
	"example.com/pideck/internal/apptext"
)

// phoneAlertVolume is fixed: the phone's own volume buttons are the
// control a user reaches for, so the app keeps no second one.
const phoneAlertVolume = 0.7

// playAlert sounds a moment when the phone's switch is on.
func (a *mobileApp) playAlert(kind string) {
	if a.sounds == nil || !a.soundOn.GetUntracked() {
		return
	}
	name := a.soundName.GetUntracked()
	if _, ok := alerts.Data(name); !ok {
		name = alerts.Default(kind)
	}
	a.sounds.Play(name, phoneAlertVolume)
}

// setSoundOn stores whether the phone sounds an alert.
func (a *mobileApp) setSoundOn(on bool) {
	a.soundOn.Set(on)
	a.saveLook()
}

// setSoundName stores which built-in sound it plays; "" is each moment's
// own default. Picking one plays it, so the choice is heard as it is made.
func (a *mobileApp) setSoundName(name string) {
	a.soundName.Set(name)
	a.saveLook()
	a.playAlert(alerts.KindDone)
}

// phoneSoundChoices are the built-in sounds the phone offers, its default
// first.
func phoneSoundChoices() []string {
	return append([]string{""}, alerts.Names()...)
}

// phoneSoundName names a choice for the picker.
func phoneSoundName(name string) string {
	switch name {
	case alerts.NameChime:
		return apptext.T("清铃")
	case alerts.NameBell:
		return apptext.T("钟声")
	case alerts.NamePop:
		return apptext.T("气泡")
	case alerts.NameBuzz:
		return apptext.T("蜂鸣")
	default:
		return apptext.T("默认")
	}
}
