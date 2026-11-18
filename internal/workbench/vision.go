//go:build !js && !android && !ios

package workbench

// The vision bridge: a picture and a question go to a vision model, and
// its description comes back as text for a model that cannot see.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// visionTimeout is how long a provider may take to read one image.
const visionTimeout = 120 * time.Second

// defaultVisionQuestion asks for what a text-only model would need.
const defaultVisionQuestion = "详细描述这张图片的内容；如果图里有文字，原样抄下来。"

// describeImage asks a vision model what an image shows. The provider is
// OpenAI-compatible: a chat completion with the image inlined as a data
// URL.
func describeImage(cfg providerConfig, model, question string, raw []byte, mime string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	switch {
	case base == "":
		return "", errors.New("这个供应商没有 Base URL")
	case strings.TrimSpace(model) == "":
		return "", errors.New("先填一个视觉模型名")
	case len(raw) == 0:
		return "", errors.New("先选一张图片")
	}
	if strings.TrimSpace(question) == "" {
		question = defaultVisionQuestion
	}
	if mime == "" {
		mime = imageMimeOf(raw)
	}
	data := base64.StdEncoding.EncodeToString(raw)
	body, err := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]any{{
			"role": "user",
			"content": []map[string]any{
				{"type": "text", "text": question},
				{"type": "image_url", "image_url": map[string]string{"url": "data:" + mime + ";base64," + data}},
			},
		}},
		"max_tokens": 900,
	})
	if err != nil {
		return "", err
	}
	status, resp, err := providerRequestTimeout(http.MethodPost, base+"/chat/completions", providerKey(cfg), body, visionTimeout)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("HTTP %d：%s", status, shorten(string(resp), 200))
	}
	return parseVisionAnswer(resp)
}

// parseVisionAnswer reads the description from a chat completion, whose
// message content may be a string or a list of parts.
func parseVisionAnswer(raw []byte) (string, error) {
	var out struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(raw, &out) != nil || len(out.Choices) == 0 {
		return "", errors.New("返回里没有描述")
	}
	content := strings.TrimSpace(string(out.Choices[0].Message.Content))
	if content == "" || content == "null" {
		return "", errors.New("返回里的描述是空的")
	}
	if strings.HasPrefix(content, "[") {
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(content), &parts) == nil {
			var b strings.Builder
			for _, p := range parts {
				if p.Text != "" {
					b.WriteString(p.Text)
				}
			}
			if text := strings.TrimSpace(b.String()); text != "" {
				return text, nil
			}
		}
	}
	var text string
	if json.Unmarshal([]byte(content), &text) == nil {
		content = text
	}
	if strings.TrimSpace(content) == "" {
		return "", errors.New("返回里的描述是空的")
	}
	return strings.TrimSpace(content), nil
}
