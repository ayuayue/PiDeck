//go:build !js && !android && !ios

package workbench

// Speech to text for the phone's microphone: the phone records a WAV and
// sends it, and this desktop transcribes it with the credentials it holds.
// The token never leaves the computer, and the phone needs no speech
// service of its own.

import (
	"context"
	"errors"

	"example.com/pideck-lite/internal/volcvoice"
)

// maxVoiceBytes bounds a recording the phone may send: about four minutes
// of 16 kHz mono, far more than the composer's one utterance.
const maxVoiceBytes = 8 << 20

// errVoiceNotConfigured says the desktop has no speech credentials yet.
var errVoiceNotConfigured = errors.New("voice: the desktop has no speech credentials")

// transcribeVoice sends a recording to the configured speech service and
// returns what it said; an empty text with a nil error means no speech.
func (a *app) transcribeVoice(ctx context.Context, wav []byte) (string, error) {
	cfg := a.st.config()
	cred := volcvoice.Credentials{AppID: cfg.VoiceAppID, AccessToken: cfg.VoiceAccessToken}
	if !cred.Complete() {
		return "", errVoiceNotConfigured
	}
	client := a.speech
	if client == nil {
		client = &volcvoice.Client{}
	}
	return client.Transcribe(ctx, cred, wav)
}
