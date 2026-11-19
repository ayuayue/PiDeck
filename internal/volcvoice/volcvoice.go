// Package volcvoice transcribes a recording with Volcano Engine's streaming
// speech recognition, its one-shot "flash" endpoint: one WAV in, one
// transcript out. It speaks only HTTP and JSON, so the desktop calls it
// with a recording the phone made.
//
// The app holds the credentials: the phone never sees the access token,
// and the request is one call rather than a socket the phone would keep
// open through a tunnel.
package volcvoice

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// Endpoint is Volcano's flash recognition API.
	Endpoint = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
	// resourceID is the flash model's resource: big model, turbo.
	resourceID = "volc.bigasr.auc_turbo"
	// successCode is the business code of a recognized recording.
	successCode = "20000000"
	// silentCode says the recording held no speech; it is an empty
	// transcript, not a failure to report as an error.
	silentCode = "20000003"
	// maxReply bounds what the service's reply may cost in memory.
	maxReply = 256 << 10
)

// The reasons a transcription fails, which the caller turns into words.
var (
	// ErrAuth says the credentials were refused: check the App ID and the
	// Access Token, and that the account may use the flash model.
	ErrAuth = errors.New("volcvoice: credentials refused")
	// ErrRejected says the service refused the recording, such as a
	// format it cannot read, or refused the request for another reason.
	ErrRejected = errors.New("volcvoice: request rejected")
	// ErrSilent says the recording held no speech.
	ErrSilent = errors.New("volcvoice: no speech")
	// ErrUnavailable says the service could not be reached or answered
	// with something that is not a transcript.
	ErrUnavailable = errors.New("volcvoice: service unavailable")
)

// Credentials identify the app on Volcano's speech service.
type Credentials struct {
	AppID       string
	AccessToken string
}

// Complete says both parts are set.
func (c Credentials) Complete() bool {
	return strings.TrimSpace(c.AppID) != "" && strings.TrimSpace(c.AccessToken) != ""
}

// Client calls the service. A zero Client uses http.DefaultClient and the
// public endpoint; a test sets both.
type Client struct {
	HTTP     *http.Client
	Endpoint string
}

// Transcribe sends a WAV recording and returns what it says, trimmed. An
// empty transcript with a nil error means the recording held no speech,
// which the caller can tell the user without treating it as a failure.
func (c *Client) Transcribe(ctx context.Context, cred Credentials, wav []byte) (string, error) {
	if !cred.Complete() {
		return "", ErrAuth
	}
	if len(wav) == 0 {
		return "", ErrSilent
	}
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = Endpoint
	}
	body, err := json.Marshal(request{
		User:    user{UID: strings.TrimSpace(cred.AppID)},
		Audio:   audio{Format: "wav", Data: base64.StdEncoding.EncodeToString(wav)},
		Request: requestOptions{ModelName: "bigmodel", EnableITN: true, EnablePunc: true},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Resource-Id", resourceID)
	req.Header.Set("X-Api-Request-Id", requestID())
	req.Header.Set("X-Api-Sequence", "-1")
	req.Header.Set("X-Api-App-Key", strings.TrimSpace(cred.AppID))
	req.Header.Set("X-Api-Access-Key", strings.TrimSpace(cred.AccessToken))

	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxReply))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	code := resp.Header.Get("x-api-status-code")
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", failure(ErrAuth, code, resp.Header, raw)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", failure(ErrRejected, code, resp.Header, raw)
	}
	switch code {
	case "", successCode:
		// A successful reply carries the transcript below.
	case silentCode:
		return "", ErrSilent
	case "45000010", "45000030":
		return "", failure(ErrAuth, code, resp.Header, raw)
	default:
		return "", failure(ErrRejected, code, resp.Header, raw)
	}
	text := transcript(raw)
	if text == "" {
		return "", ErrSilent
	}
	return text, nil
}

// request, user, audio and requestOptions are the service's body, named as
// its documentation does.
type request struct {
	User    user           `json:"user"`
	Audio   audio          `json:"audio"`
	Request requestOptions `json:"request"`
}

type user struct {
	UID string `json:"uid"`
}

type audio struct {
	Format string `json:"format"`
	Data   string `json:"data"`
}

type requestOptions struct {
	ModelName  string `json:"model_name"`
	EnableITN  bool   `json:"enable_itn"`
	EnablePunc bool   `json:"enable_punc"`
}

// reply is what the service answers: result.text, or result itself when it
// is a string.
type reply struct {
	Result json.RawMessage `json:"result"`
}

// transcript reads the text out of a successful reply.
func transcript(raw []byte) string {
	var r reply
	if json.Unmarshal(raw, &r) != nil || len(r.Result) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(r.Result, &text) == nil {
		return strings.TrimSpace(text)
	}
	var result struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(r.Result, &result) != nil {
		return ""
	}
	if len(result.Text) > 100_000 {
		return ""
	}
	return strings.TrimSpace(result.Text)
}

// failure names a refusal with the service's own code and words, so the
// desktop's log and the phone's message say what happened.
func failure(kind error, code string, header http.Header, raw []byte) error {
	message := header.Get("x-api-message")
	if message == "" {
		var body struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &body) == nil {
			message = body.Message
		}
	}
	if len(message) > 200 {
		message = message[:200]
	}
	logID := header.Get("x-tt-logid")
	switch {
	case code != "" && message != "":
		return fmt.Errorf("%w: %s %s (log %s)", kind, code, message, logID)
	case code != "":
		return fmt.Errorf("%w: %s (log %s)", kind, code, logID)
	default:
		return kind
	}
}

// requestID is a random UUID, which the service takes with every call and
// repeats in its logs.
func requestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
