package main

// Image generation through a provider's OpenAI-compatible
// /images/generations endpoint. The app asks the provider directly and
// hands the bytes back to the dialog, which can attach them to the
// composer or save them into the project.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// imageGenTimeout is how long a provider may take to draw one image.
const imageGenTimeout = 180 * time.Second

// generatedImage is one picture a provider returned.
type generatedImage struct {
	Data []byte
	Mime string
}

// generateImage asks a provider for n images and returns them.
func generateImage(cfg providerConfig, model, prompt, size string, n int) ([]generatedImage, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	switch {
	case base == "":
		return nil, errors.New("这个供应商没有 Base URL")
	case strings.TrimSpace(prompt) == "":
		return nil, errors.New("先写一句画面描述")
	case strings.TrimSpace(model) == "":
		return nil, errors.New("先填图片模型名")
	}
	if n < 1 {
		n = 1
	}
	if n > 4 {
		n = 4
	}
	body, err := json.Marshal(map[string]any{
		"model": model, "prompt": prompt, "n": n, "size": size,
	})
	if err != nil {
		return nil, err
	}
	status, data, err := providerRequestTimeout(http.MethodPost, base+"/images/generations", providerKey(cfg), body, imageGenTimeout)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("HTTP %d：%s", status, shorten(string(data), 200))
	}
	var out struct {
		Data []struct {
			B64 string `json:"b64_json"`
			URL string `json:"url"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &out) != nil || len(out.Data) == 0 {
		return nil, errors.New("返回里没有图片")
	}
	var images []generatedImage
	for _, item := range out.Data {
		if b64 := strings.TrimSpace(item.B64); b64 != "" {
			raw, err := base64.StdEncoding.DecodeString(b64)
			if err != nil {
				return nil, fmt.Errorf("图片数据不对：%w", err)
			}
			images = append(images, generatedImage{Data: raw, Mime: imageMimeOf(raw)})
			continue
		}
		if u := strings.TrimSpace(item.URL); u != "" {
			raw, err := downloadImage(u)
			if err != nil {
				return nil, err
			}
			images = append(images, generatedImage{Data: raw, Mime: imageMimeOf(raw)})
		}
	}
	if len(images) == 0 {
		return nil, errors.New("返回里没有图片")
	}
	return images, nil
}

// downloadImage reads an image a provider linked instead of inlining.
func downloadImage(rawURL string) ([]byte, error) {
	resp, err := appHTTPLongClient.Get(rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("下载图片失败：HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 24<<20))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, errors.New("下载到的图片是空的")
	}
	return raw, nil
}

// imageMimeOf names an image's type from its first bytes.
func imageMimeOf(raw []byte) string {
	m := http.DetectContentType(raw)
	if strings.HasPrefix(m, "image/") {
		return m
	}
	return "image/png"
}

// imageExt is a file extension for an image's MIME type.
func imageExt(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	}
	return ".png"
}
