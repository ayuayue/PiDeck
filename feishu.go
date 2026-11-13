package main

// Feishu group bots: a finished turn can post its title, status and a
// short summary to a webhook. The bot may sign requests with a secret, as
// Feishu's custom bots do.

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/ui"
)

// feishuSign is a custom bot's signature: HMAC-SHA256 of an empty body,
// keyed by "timestamp\nsecret", base64 encoded.
func feishuSign(secret string, timestamp int64) string {
	mac := hmac.New(sha256.New, []byte(fmt.Sprintf("%d\n%s", timestamp, secret)))
	mac.Write(nil)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// sendFeishu posts one text message to a custom bot's webhook.
func sendFeishu(webhook, secret, text string) error {
	webhook = strings.TrimSpace(webhook)
	if !strings.HasPrefix(webhook, "https://") && !strings.HasPrefix(webhook, "http://") {
		return fmt.Errorf("Webhook 需要是 http(s) 地址")
	}
	payload := map[string]any{
		"msg_type": "text",
		"content":  map[string]string{"text": text},
	}
	if secret = strings.TrimSpace(secret); secret != "" {
		ts := time.Now().Unix()
		payload["timestamp"] = fmt.Sprint(ts)
		payload["sign"] = feishuSign(secret, ts)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, webhook, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := appHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d：%s", resp.StatusCode, shorten(string(data), 160))
	}
	var answer struct {
		Code       int    `json:"code"`
		Msg        string `json:"msg"`
		StatusCode int    `json:"StatusCode"`
		StatusMsg  string `json:"StatusMessage"`
	}
	if json.Unmarshal(data, &answer) == nil {
		if answer.Code != 0 {
			return fmt.Errorf("飞书返回 %d：%s", answer.Code, answer.Msg)
		}
		if answer.StatusCode != 0 {
			return fmt.Errorf("飞书返回 %d：%s", answer.StatusCode, answer.StatusMsg)
		}
	}
	return nil
}

// notifyFeishu posts a finished turn, when the integration is on.
func (a *app) notifyFeishu(s *session, status, body string) {
	if !a.cfg.FeishuEnabled || strings.TrimSpace(a.cfg.FeishuWebhook) == "" || s == nil {
		return
	}
	text := s.title.GetUntracked() + "\n" + status
	if body = strings.TrimSpace(body); body != "" {
		text += "\n" + firstLine(body, 200)
	}
	webhook, secret := a.cfg.FeishuWebhook, a.cfg.FeishuSecret
	go func() { _ = sendFeishu(webhook, secret, text) }()
}

// testFeishu posts a test message and says how it went.
func (a *app) testFeishu() {
	webhook := strings.TrimSpace(a.cfg.FeishuWebhook)
	if webhook == "" {
		a.toast(ui.ToastWarning, "还没有 Webhook", "先在飞书群里添加自定义机器人，把它的地址填进来。")
		return
	}
	go func() {
		err := sendFeishu(webhook, a.cfg.FeishuSecret, "PiDeck Lite 测试消息：连接正常。")
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "飞书测试失败", err.Error())
				return
			}
			a.toast(ui.ToastSuccess, "飞书测试成功", "去群里看看那条消息。")
		})
	}()
}
