//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/nsgo-dev/nsgo/ui"
)

const (
	promptTemplateFile = "prompt-enhance.md"
	promptTemplateMax  = 24 << 10
)

func validatePromptTemplate(text string) error {
	if len(text) > promptTemplateMax || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return errors.New("模板需为有效的 UTF-8 文本，且不超过 24 KB。")
	}
	if strings.TrimSpace(text) == "" {
		return errors.New("模板不能为空；可以恢复默认模板。")
	}
	return nil
}

// readPromptTemplate is bounded and always returns a usable instruction.
// A missing or invalid user file never prevents a draft tool from working.
func readPromptTemplate(dir string) (string, error) {
	fallback := toolSystem("prompt")
	f, err := os.Open(filepath.Join(dir, promptTemplateFile))
	if errors.Is(err, os.ErrNotExist) {
		return fallback, nil
	}
	if err != nil {
		return fallback, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, promptTemplateMax+1))
	if err != nil {
		return fallback, err
	}
	if err := validatePromptTemplate(string(raw)); err != nil {
		return fallback, err
	}
	return string(raw), nil
}

func savePromptTemplate(dir, text string) error {
	if err := validatePromptTemplate(text); err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, promptTemplateFile), []byte(text), 0o600)
}

// completeDraftTool runs off the UI thread for both desktop and HTTP callers.
// The template is an app instruction, kept separate from the user's draft.
func (a *app) completeDraftTool(ctx context.Context, tool, draft string) (string, error) {
	system := toolSystem(tool)
	if tool == "prompt" && a.st != nil {
		text, err := readPromptTemplate(a.st.dir)
		system = text
		if err != nil {
			a.cx.Post(func() {
				a.toast(ui.ToastWarning, "增强模板不可用，已使用默认模板", "请打开增强模板，检查文本后重新保存。")
			})
		}
	}
	if a.llmFn != nil {
		return a.llmFn(tool, system, draft, toolTokens(tool))
	}
	return a.llmComplete(ctx, tool, system, draft, toolTokens(tool))
}
