//go:build !js && !android && !ios

package workbench

// Speech to text for the phone's microphone: the phone records a WAV and
// sends it, and this desktop transcribes it with the credentials it holds.
// The token never leaves the computer, and the phone needs no speech
// service of its own.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"

	"example.com/pideck-v2/internal/volcvoice"
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
	if cfg.VoiceLocalURL != "" {
		return transcribeWhisper(ctx, cfg.VoiceLocalURL, wav)
	}
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

// Whisper's OpenAI-compatible server stays outside the app. Only loopback
// endpoints are accepted here, so recordings cannot be redirected to a cloud.
func whisperURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
		return "", errors.New("Whisper requires a loopback HTTP URL")
	}
	return strings.TrimRight(u.String(), "/") + "/v1/audio/transcriptions", nil
}

func transcribeWhisper(ctx context.Context, address string, wav []byte) (string, error) {
	endpoint, err := whisperURL(address)
	if err != nil {
		return "", err
	}
	if len(wav) == 0 || len(wav) > maxVoiceBytes {
		return "", errors.New("invalid recording size")
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", "recording.wav")
	if err != nil {
		return "", err
	}
	if _, err := part.Write(wav); err != nil {
		return "", err
	}
	if err := w.WriteField("model", "whisper-1"); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	client := http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Whisper HTTP %d", res.StatusCode)
	}
	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&result); err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Text), nil
}
