//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"example.com/pideck-v2/internal/appinfo"
)

const wechatBase = "https://ilinkai.weixin.qq.com"

var errWechatExpired = errors.New("iLink session expired; sign in again")

type wechatClient struct{ base, token string }
type wechatQR struct {
	QRCode   string `json:"qrcode"`
	Content  string `json:"qrcode_img_content"`
	Status   string `json:"status"`
	Token    string `json:"bot_token"`
	Owner    string `json:"ilink_user_id"`
	Base     string `json:"baseurl"`
	Redirect string `json:"redirect_host"`
}
type wechatMessage struct {
	ID      int64  `json:"message_id"`
	From    string `json:"from_user_id"`
	Group   string `json:"group_id"`
	Type    int    `json:"message_type"`
	Context string `json:"context_token"`
	Items   []struct {
		Type int `json:"type"`
		Text struct {
			Text string `json:"text"`
		} `json:"text_item"`
		Voice struct {
			Text string `json:"text"`
		} `json:"voice_item"`
	} `json:"item_list"`
}
type wechatUpdates struct {
	Messages []wechatMessage `json:"msgs"`
	Cursor   string          `json:"get_updates_buf"`
}

func trustedWechatBase(raw string) (string, error) {
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" || (u.Path != "" && u.Path != "/") || !(u.Hostname() == "ilinkai.weixin.qq.com" || strings.HasSuffix(u.Hostname(), ".weixin.qq.com")) {
		return "", errors.New("untrusted iLink API host")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func (c wechatClient) request(ctx context.Context, method, path string, body any, out any, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var data io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		data = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, data)
	if err != nil {
		return err
	}
	var random [4]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	req.Header.Set("AuthorizationType", "ilink_bot_token")
	req.Header.Set("X-WECHAT-UIN", base64.StdEncoding.EncodeToString([]byte(strconv.FormatUint(uint64(binary.BigEndian.Uint32(random[:])), 10))))
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	// Never forward a bot credential through an HTTP redirect.
	client := *appHTTPLongClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("iLink HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 2<<20 {
		return errors.New("iLink response too large")
	}
	var status struct {
		Ret  int `json:"ret"`
		Code int `json:"errcode"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return errors.New("invalid iLink response")
	}
	if status.Ret == -14 || status.Code == -14 {
		return errWechatExpired
	}
	if status.Ret != 0 || status.Code != 0 {
		return fmt.Errorf("iLink error %d/%d", status.Ret, status.Code)
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func wechatInfo() map[string]string {
	// Tencent defines this as the channel implementation version, not a
	// protocol revision. Do not impersonate another client's app ID/version.
	return map[string]string{"channel_version": appinfo.Version, "bot_agent": "PiDeck-V2"}
}
func (c wechatClient) updates(ctx context.Context, cursor string) (wechatUpdates, error) {
	var out wechatUpdates
	err := c.request(ctx, http.MethodPost, "/ilink/bot/getupdates", map[string]any{"get_updates_buf": cursor, "base_info": wechatInfo()}, &out, 40*time.Second)
	return out, err
}
func (c wechatClient) send(ctx context.Context, to, token, text string) error {
	if to == "" || token == "" {
		return errors.New("iLink reply has no recipient context")
	}
	return c.request(ctx, http.MethodPost, "/ilink/bot/sendmessage", map[string]any{
		"base_info": wechatInfo(), "msg": map[string]any{"from_user_id": "", "to_user_id": to, "client_id": "pideck-" + newSessionID(), "message_type": 2, "message_state": 2, "context_token": token,
			"item_list": []any{map[string]any{"type": 1, "text_item": map[string]string{"text": text}}}},
	}, nil, 15*time.Second)
}

func wechatText(m wechatMessage) string {
	var parts []string
	for _, item := range m.Items {
		switch item.Type {
		case 1:
			parts = append(parts, item.Text.Text)
		case 3:
			parts = append(parts, item.Voice.Text)
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if len(text) > 24<<10 {
		return ""
	}
	return text
}

func wechatWait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
