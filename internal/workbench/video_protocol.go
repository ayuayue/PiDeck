//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// These are TokenDance's protocol-specific gateway routes, not a made-up
// unified endpoint. Both match the upstream PiDeck protocol families.
func videoRoute(family string) (submit, query string, err error) {
	switch family {
	case "ark":
		return "/gateway/ark/v3/generations/tasks", "/gateway/ark/v3/generations/tasks/", nil
	case "minimax":
		return "/gateway/minimax/v2/video_generation", "/gateway/minimax/v2/query/video_generation/", nil
	default:
		return "", "", errors.New("unsupported video protocol")
	}
}

func videoRequest(ctx context.Context, cfg providerConfig, method, path string, payload any) (map[string]any, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if !isHTTPURL(base) {
		return nil, errors.New("invalid video gateway URL")
	}
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, err
	}
	if key := providerKey(cfg); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := appHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 1<<20 {
		return nil, errors.New("video response exceeds size limit")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("video HTTP %d", res.StatusCode)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func submitVideo(ctx context.Context, cfg providerConfig, j videoJob) (string, error) {
	route, _, err := videoRoute(j.Family)
	if err != nil {
		return "", err
	}
	payload := map[string]any{"model": j.Model, "content": []map[string]string{{"type": "text", "text": j.Prompt}}}
	if j.Duration > 0 {
		payload["duration"] = j.Duration
	}
	if j.Ratio != "" {
		payload["ratio"] = j.Ratio
	}
	if j.Resolution != "" {
		r := strings.ToLower(j.Resolution)
		if j.Family == "minimax" {
			r = strings.ToUpper(r)
		}
		payload["resolution"] = r
	}
	out, err := videoRequest(ctx, cfg, http.MethodPost, route, payload)
	if err != nil {
		return "", err
	}
	for _, key := range []string{"task_id", "taskId", "id"} {
		if id, ok := out[key].(string); ok && strings.TrimSpace(id) != "" && len(id) < 512 {
			return id, nil
		}
	}
	return "", errors.New("video submit response has no task ID")
}

func videoStatus(out map[string]any) (state, artifact string, err error) {
	task, _ := out["task"].(map[string]any)
	if task == nil {
		task = out
	}
	raw, _ := task["status"].(string)
	switch strings.ToLower(raw) {
	case "queued", "pending", "waiting", "created":
		state = "queued"
	case "running", "processing", "preparing", "generating":
		state = "running"
	case "succuess", "succeed", "succeeded", "success", "completed", "done":
		state = "succeeded"
	case "failed", "error", "cancelled", "expired":
		return "failed", "", errors.New("video generation failed: " + shorten(raw, 60))
	default:
		return "", "", errors.New("unknown video task status: " + shorten(raw, 60))
	}
	if state != "succeeded" {
		return state, "", nil
	}
	for _, obj := range []map[string]any{task, out} {
		for _, key := range []string{"content", "file"} {
			values, _ := obj[key].(map[string]any)
			for _, field := range []string{"video_url", "url", "download_url"} {
				if u, ok := values[field].(string); ok && isHTTPURL(u) {
					return state, u, nil
				}
			}
		}
		items, _ := obj["artifacts"].([]any)
		for _, item := range items {
			m, _ := item.(map[string]any)
			if u, ok := m["url"].(string); ok && isHTTPURL(u) {
				return state, u, nil
			}
		}
	}
	return "", "", errors.New("completed video has no artifact URL")
}

func queryVideo(ctx context.Context, cfg providerConfig, j videoJob) (string, string, error) {
	_, route, err := videoRoute(j.Family)
	if err != nil {
		return "", "", err
	}
	out, err := videoRequest(ctx, cfg, http.MethodGet, route+url.PathEscape(j.Task), nil)
	if err != nil {
		return "", "", err
	}
	return videoStatus(out)
}
