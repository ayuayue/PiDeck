//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/base64"
	"image"
	"net/http"
	"strings"

	"example.com/pideck-v2/internal/remotewire"
)

const transcriptImagesPerMessage = 4

func transcriptImage(data []byte) (remotewire.Image, bool) {
	if len(data) == 0 || len(data) > remotewire.MaxTranscriptImageBytes {
		return remotewire.Image{}, false
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width) > 24_000_000/int64(cfg.Height) {
		return remotewire.Image{}, false
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return remotewire.Image{Data: data, MimeType: mime}, true
	default:
		return remotewire.Image{}, false
	}
}

func piBlockImages(blocks []piContent) []remotewire.Image {
	var out []remotewire.Image
	for _, block := range blocks {
		if block.Type != "image" || len(out) >= transcriptImagesPerMessage {
			continue
		}
		image := remotewire.Image{Name: "图片"}
		if len(block.Data) <= base64.StdEncoding.EncodedLen(remotewire.MaxTranscriptImageBytes) {
			if bytes, err := base64.StdEncoding.DecodeString(block.Data); err == nil {
				if decoded, ok := transcriptImage(bytes); ok {
					image.Data, image.MimeType = decoded.Data, decoded.MimeType
				}
			}
		}
		out = append(out, image)
	}
	return out
}

func toolRunFromResult(m piMessage) toolRun {
	blocks := m.blocks()
	return toolRun{CallID: m.ToolCallID, Name: m.ToolName, Output: strings.TrimSpace(piBlockText(blocks)),
		Images: piBlockImages(blocks), Ask: askResultFromDetails(m.ToolName, m.Details), filePaths: toolFileArgs(m.Details),
		IsError: m.IsError, DurationMs: m.DurationMs}
}
