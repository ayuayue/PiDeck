//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/microphone"
	"github.com/nsgo-dev/nsgo/ui"
)

type desktopVoice struct {
	ctx       context.Context
	state     *core.Signal[string]
	recording *microphone.Recording
	owner     *session
	closed    bool
}

func (a *app) initVoiceCapture() {
	a.voiceCapture = desktopVoice{state: core.NewSignal(a.cx, ""), ctx: a.cx.Context()}
	a.cx.Cleanup(func() {
		a.voiceCapture.closed = true
		if rec := a.voiceCapture.recording; rec != nil {
			a.voiceCapture.recording = nil
			go func() { rec.Stop(); _ = os.Remove(rec.File().Path) }()
		}
	})
}

func (a *app) voiceCaptureButton(s *session) core.Node {
	if !microphone.Supported() {
		return nil
	}
	return core.Dynamic(func(cx *core.Scope) core.Node {
		state := a.voiceCapture.state.Get()
		icon, label := lucide.Mic, apptext.T("语音输入")
		if state == "recording" {
			icon, label = lucide.Square, apptext.T("结束录音")
		}
		return a.pressIcon(icon, label, 26, 13, func() bool { return a.voiceCapture.state.Get() == "busy" }, func() {
			if a.voiceCapture.recording != nil {
				a.stopVoiceCapture()
				return
			}
			a.startVoiceCapture(s)
		}, "desktop-voice")
	})
}

func (a *app) startVoiceCapture(s *session) {
	if a.voiceCapture.state.GetUntracked() != "" {
		return
	}
	a.voiceCapture.state.Set("busy")
	a.voiceCapture.owner = s
	ctx := a.voiceCapture.ctx
	go func() {
		rec, err := microphone.RecordWAV("pideck-"+newSessionID(), microphone.RecordOptions{Rate: 16000, Channels: 1})
		handed := make(chan struct{})
		a.cx.Post(func() {
			defer close(handed)
			if err != nil {
				a.voiceCapture.state.Set("")
				a.toast(ui.ToastError, "录音失败", err.Error())
				return
			}
			if a.voiceCapture.closed || a.byID[s.ID] != s || s.deleting {
				go func() { rec.Stop(); _ = os.Remove(rec.File().Path) }()
				a.voiceCapture.state.Set("")
				return
			}
			a.voiceCapture.recording = rec
			a.voiceCapture.state.Set("recording")
			a.cx.AfterFunc(3*time.Minute, func() {
				if a.voiceCapture.recording == rec {
					a.stopVoiceCapture()
				}
			})
			go func() {
				<-rec.Ended()
				a.cx.Post(func() {
					if a.voiceCapture.recording == rec {
						a.stopVoiceCapture()
					}
				})
			}()
		})
		// A disposed scope drops Post callbacks. Until the UI takes
		// ownership, this goroutine must clean up the native recording.
		select {
		case <-handed:
		case <-ctx.Done():
			if rec != nil {
				rec.Stop()
				_ = os.Remove(rec.File().Path)
			}
		}
	}()
}

func (a *app) stopVoiceCapture() {
	rec, s := a.voiceCapture.recording, a.voiceCapture.owner
	if rec == nil {
		return
	}
	a.voiceCapture.recording = nil
	a.voiceCapture.state.Set("busy")
	go func() {
		rec.Stop()
		file := rec.File().Path
		defer os.Remove(file)
		a.transcribeRecording(s, file)
	}()
}

func (a *app) pickVoiceRecording(s *session) {
	if a.voiceCapture.state.GetUntracked() != "" {
		return
	}
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{".wav"}}, func(files []core.File, err error) {
		if err != nil {
			a.toast(ui.ToastError, "选择文件失败", err.Error())
			return
		}
		if len(files) == 0 {
			return
		}
		a.voiceCapture.state.Set("busy")
		go a.transcribeRecording(s, files[0].Path)
	})
}

func (a *app) transcribeRecording(s *session, file string) {
	var audio []byte
	f, err := os.Open(file)
	if err == nil {
		audio, err = io.ReadAll(io.LimitReader(f, maxVoiceBytes+1))
		f.Close()
	}
	if err == nil && (len(audio) > maxVoiceBytes || len(audio) < 12 || string(audio[:4]) != "RIFF" || string(audio[8:12]) != "WAVE") {
		err = errors.New(apptext.T("请选择不超过 8 MB 的 WAV 录音。"))
	}
	var text string
	if err == nil {
		ctx, cancel := context.WithTimeout(a.voiceCapture.ctx, 90*time.Second)
		text, err = a.transcribeVoice(ctx, audio)
		cancel()
	}
	a.cx.Post(func() {
		a.voiceCapture.state.Set("")
		if err != nil {
			a.toast(ui.ToastError, "语音转写失败", err.Error())
			return
		}
		if a.byID[s.ID] != s || s.deleting {
			return
		}
		text = strings.TrimSpace(text)
		if text == "" {
			a.toast(ui.ToastInfo, "录音是空的", "")
			return
		}
		s.draft.Update(func(draft string) string {
			if strings.TrimSpace(draft) == "" {
				return text
			}
			return draft + "\n" + text
		})
	})
}
