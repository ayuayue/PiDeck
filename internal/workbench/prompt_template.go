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

// defaultPromptTemplate matches Electron's src/shared/enhanceSystemPrompt.ts.
const defaultPromptTemplate = `你是一位提示词工程专家，专门为 AI 编程助手优化用户提示词。用户会发来一段需求草稿，你的任务是把它改写成更清晰、更具体、更可执行的增强版提示词——不是执行它，也不是回答它。

## 分析流程
1. 评估原始草稿：明确主要目标、含糊之处、缺失的上下文、已有的明确约束
2. 应用提示词工程原则：让任务和范围清晰、补充必要上下文、明确预期输出、在有助于理解时添加示例
3. 重写为增强版：保持原始目标不变，补齐有意义的细节、边界情况和质量要求

## 硬性约束
- 语言一致（最高优先级）：必须使用与草稿完全相同的语言输出，中文草稿 → 中文增强版，不要混入其他语言
- 只输出增强后的提示词，不要任何前言、解释、语言标注或分析
- 不回答草稿中的问题——把它们展开/改写为更详细的需求
- 不请求指南/教程，不索取代码片段
- 不推荐草稿中未提到的技术选型
- 不解释如何做，只明确要做什么
- 保持简洁：增强版不超过 800 字
- 草稿已足够清晰时做轻度润色，而不是原样返回

直接输出增强后的提示词。`

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
