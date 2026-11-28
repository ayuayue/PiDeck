//go:build !js && !android && !ios

package workbench

// The phone server's composer controls: what the next turn asks for, the
// backend the session runs on, the draft tools the desktop's models run for
// it, and a picture drawn from the phone's words.

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
)

// sessionMode switches what the next turn asks for: a plan first, a goal
// that goes on by itself, a picture, or a normal prompt.
func (h *remoteHost) sessionMode(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	mode := strings.TrimSpace(body.Mode)
	switch mode {
	case "", modeNormal:
		mode = modeNormal
	case modePlan, modeGoal, modeImage:
	default:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("不认识的模式")})
		return
	}
	var failure error
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		h.app.setAgentMode(s, mode)
	})
	answer := mode
	if mode == modeNormal {
		answer = ""
	}
	h.finishAction(w, ok, failure, map[string]any{"ok": true, "mode": answer})
}

// sessionBackend switches a session that has not started yet between pi and
// an ACP preset; its first message fixes where the transcript lives.
func (h *remoteHost) sessionBackend(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Backend string `json:"backend"`
		Preset  string `json:"preset"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	backend, preset := strings.TrimSpace(body.Backend), strings.TrimSpace(body.Preset)
	switch backend {
	case "", "pi":
		backend, preset = "pi", ""
	case "acp":
		if preset == "" {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("缺少 ACP 预设")})
			return
		}
	default:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("不认识的后端")})
		return
	}
	var failure error
	name := "pi"
	ok := h.app.withUI(func() {
		s := h.app.byID[id]
		if s == nil {
			failure = errors.New("找不到这个会话")
			return
		}
		if h.app.backendLocked(s) {
			failure = errors.New(apptext.T("这个会话已经开始了：换后端要新建会话"))
			return
		}
		if backend == "acp" {
			p := h.app.acpPresetByID(preset)
			if p == nil {
				failure = errors.New(apptext.T("电脑上没有这个 ACP 预设"))
				return
			}
			name = p.Name
		}
		h.app.setBackend(s, backend, preset)
	})
	h.finishAction(w, ok, failure, map[string]any{"ok": true, "backend": backend, "name": name})
}

// sessionTool runs one of the desktop's draft tools on the phone's text:
// the model rewrites or continues it, and the answer goes back to the
// phone instead of into the desktop's composer.
func (h *remoteHost) sessionTool(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Tool string `json:"tool"`
		Text string `json:"text"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	tool := strings.TrimSpace(body.Tool)
	if tool != "prompt" && tool != "predict" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("不认识这个工具")})
		return
	}
	text := strings.TrimSpace(body.Text)
	switch {
	case text == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("先写点东西再用")})
		return
	case len([]rune(text)) > 8000:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("草稿太长了")})
		return
	}
	var found, busy bool
	ok := h.app.withUI(func() {
		found = h.app.byID[id] != nil
		busy = h.app.toolConfigured(tool)
	})
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	case !found:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个会话"})
		return
	case !busy:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("电脑上还没给这个工具配置模型")})
		return
	}
	// The model call is a network request: it stays off the UI thread.
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	answer, err := h.app.completeDraftTool(ctx, tool, text)
	if err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": viewkit.FirstLine(err.Error(), 220)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"text": cleanLLMText(answer)})
}

// sessionImage draws a picture from the phone's words, with the desktop's
// image provider, and hands it back to the phone's composer.
func (h *remoteHost) sessionImage(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Prompt string `json:"prompt"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	switch {
	case prompt == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("先写一句画面描述")})
		return
	case len([]rune(prompt)) > 2000:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("描述太长了")})
		return
	}
	var cfg providerConfig
	var model, size string
	var found, configured bool
	ok := h.app.withUI(func() {
		found = h.app.byID[id] != nil
		want := h.app.imageProviderForComposer()
		for _, p := range readProviderConfigs() {
			if p.ID == want {
				cfg, configured = p, true
				break
			}
		}
		model = strings.TrimSpace(h.app.cfg.ImageModel)
		size = firstNonEmpty(h.app.cfg.ImageSize, "1024x1024")
	})
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	case !found:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个会话"})
		return
	case !configured:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("电脑上还没有配置生图供应商")})
		return
	case model == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": apptext.T("电脑上还没有填生图模型名")})
		return
	}
	images, err := generateImage(cfg, model, prompt, size, 1)
	if err != nil {
		writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": viewkit.FirstLine(err.Error(), 220)})
		return
	}
	out := remotewire.Pictures{}
	for _, img := range images {
		out.Images = append(out.Images, remotewire.Picture{Mime: img.Mime, Data: base64.StdEncoding.EncodeToString(img.Data)})
	}
	writeRemoteJSON(w, http.StatusOK, out)
}
