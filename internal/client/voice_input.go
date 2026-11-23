package client

// The phone's microphone: press once to record, again to stop, and the
// desktop transcribes it. Recognition happens on the computer, which holds
// the speech service's credentials, so the phone needs no key of its own
// and the audio travels no further than the desktop the phone is paired
// with.

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/microphone"
	"github.com/nsgo-dev/nsgo/ui"
)

// The states the microphone button shows.
const (
	voiceIdle      = ""
	voiceRecording = "recording"
	voiceBusy      = "busy"
)

// canVoice says this build can record: Android, once nsgo.yaml declares
// the recording service. The browser and a desktop preview cannot.
func canVoice() bool { return microphone.Supported() }

// voiceButton is the microphone in the composer's row; it is absent where
// the platform cannot record.
func (a *mobileApp) voiceButton(src composerSource) core.Node {
	return core.Show{When: func() bool { return canVoice() }, Then: func(*core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			state := a.voice.Get()
			if state == voiceBusy {
				return core.View{TestID: "mobile-voice", Style: core.Style{Width: core.Pt(28), Height: core.Pt(28),
					AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
					Children: []core.Node{ui.Spinner{Size: 14, Label: apptext.T("转写中")}}}
			}
			icon, label := lucide.Mic, apptext.T("语音输入")
			tint := colors.Muted
			if state == voiceRecording {
				icon, label, tint = lucide.Square, apptext.T("结束录音"), colors.Danger
			}
			return core.View{OnPress: func(core.PressEvent) { a.toggleVoice(src) }, Role: core.RoleButton, Label: label,
				TestID: "mobile-voice",
				StyleFunc: func() core.Style {
					st := core.Style{Width: core.Pt(28), Height: core.Pt(28), AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter, CornerRadius: 8, FlexShrink: 0, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					if state == voiceRecording {
						st.Background = ui.Alpha(colors.Danger(), 0.12)
					}
					return st
				},
				Children: []core.Node{ui.Icon(icon, 15, tint)}}
		})
	}}
}

// toggleVoice starts a recording, or ends one and sends it to be
// transcribed.
func (a *mobileApp) toggleVoice(src composerSource) {
	switch a.voice.GetUntracked() {
	case voiceRecording:
		a.stopVoice()
	case voiceBusy:
		// A start still waiting on the permission prompt, or a stop still
		// being transcribed: a second press changes nothing.
	default:
		a.startVoice(src)
	}
}

// startVoice asks for the microphone, which the recording does itself, and
// waits for it off the UI thread because the permission prompt can stand
// there for as long as the user takes.
func (a *mobileApp) startVoice(src composerSource) {
	if a.voice.GetUntracked() != voiceIdle {
		return
	}
	a.voice.Set(voiceBusy)
	insert := voiceInsert(src.draft, src.setDraft)
	a.voiceInsert = insert
	name := fmt.Sprintf("voice-%d", time.Now().UnixNano())
	go func() {
		rec, err := microphone.RecordWAV(name, microphone.RecordOptions{Rate: 16000, Channels: 1})
		a.cx.Post(func() {
			if err != nil {
				a.voice.Set(voiceIdle)
				a.flash(voiceErrorText(err))
				return
			}
			a.rec = rec
			a.voice.Set(voiceRecording)
			a.flash(apptext.T("正在录音，再按一次结束"))
			// An interruption, or the system taking the microphone away,
			// ends the recording by itself: put the button back.
			go func() {
				<-rec.Ended()
				a.cx.Post(func() {
					if a.rec != rec {
						return // stopped here, which already reset the button
					}
					a.rec = nil
					a.voice.Set(voiceIdle)
					if err := rec.Err(); err != nil {
						a.flash(voiceErrorText(err))
					}
				})
			}()
		})
	}()
}

// stopVoice ends the recording, reads what it wrote and sends it to the
// desktop. The file is removed either way: it was a moment's audio.
func (a *mobileApp) stopVoice() {
	rec := a.rec
	if rec == nil {
		a.voice.Set(voiceIdle)
		return
	}
	a.rec = nil
	a.voice.Set(voiceBusy)
	insert := a.voiceInsert
	client := a.client
	go func() {
		rec.Stop()
		path := rec.File().Path
		audio, err := os.ReadFile(path)
		_ = os.Remove(path)
		if err != nil || len(audio) == 0 {
			a.cx.Post(func() {
				a.voice.Set(voiceIdle)
				a.flash(apptext.T("录音是空的"))
			})
			return
		}
		if client == nil {
			a.cx.Post(func() {
				a.voice.Set(voiceIdle)
				a.flash(apptext.T("还没有连上电脑"))
			})
			return
		}
		text, err := client.voice(audio)
		a.cx.Post(func() {
			a.voice.Set(voiceIdle)
			switch {
			case err != nil:
				a.flash(remoteErrorText(err))
			case strings.TrimSpace(text) == "":
				a.flash(apptext.T("没听清，再说一次"))
			default:
				if insert != nil {
					insert(text)
				}
				a.flash(apptext.T("已转成文字"))
			}
		})
	}()
}

// voiceInsert appends a transcript to the composer's text, with a space
// when a word would otherwise run into it.
func voiceInsert(draft func() string, set func(string)) func(string) {
	return func(text string) {
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		cur := draft()
		if cur != "" && !strings.HasSuffix(cur, " ") && !strings.HasSuffix(cur, "\n") {
			cur += " "
		}
		set(cur + text)
	}
}

// voiceErrorText says why recording failed.
func voiceErrorText(err error) string {
	switch {
	case errors.Is(err, microphone.ErrDenied):
		return apptext.T("麦克风权限被拒绝了，去系统设置里打开")
	case errors.Is(err, microphone.ErrUnsupported):
		return apptext.T("这台设备不能录音")
	case errors.Is(err, microphone.ErrUnavailable):
		return apptext.T("现在不能录音，稍后再试")
	case errors.Is(err, microphone.ErrBusy):
		return apptext.T("已经在录了")
	case errors.Is(err, microphone.ErrInterrupted):
		return apptext.T("录音被系统打断了")
	case errors.Is(err, microphone.ErrNoSpace):
		return apptext.T("手机空间不够录这段")
	default:
		return err.Error()
	}
}
