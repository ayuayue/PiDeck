//go:build !js && !android && !ios

package workbench

// Installing PiDeck's official prompt templates into pi's own prompts folder,
// where pi turns each file into a /<slug> command.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var promptSlugPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// installOfficialPromptsToPi writes each template once. An existing file is
// left alone: it may be the user's own command with the same slug.
func installOfficialPromptsToPi(pack promptPack) (added, skipped int, err error) {
	dir := piConfigDir()
	if dir == "" {
		return 0, 0, errors.New("找不到 pi 的配置目录")
	}
	target := filepath.Join(dir, "prompts")
	if err := os.MkdirAll(target, 0o755); err != nil {
		return 0, 0, err
	}
	for _, prompt := range pack.Prompts {
		slug := strings.TrimSpace(prompt.Slug)
		if !promptSlugPattern.MatchString(slug) || strings.Contains(slug, "..") {
			return added, skipped, fmt.Errorf("提示词名 %q 不合法", slug)
		}
		body := strings.TrimSpace(prompt.Body)
		if body == "" {
			body = strings.TrimSpace(prompt.Prompt)
		}
		if body == "" {
			continue
		}
		path := filepath.Join(target, slug+".md")
		if _, err := os.Stat(path); err == nil {
			skipped++
			continue
		}
		content := fmt.Sprintf("---\ndescription: %q\n---\n\n%s\n", prompt.Title, body)
		if err := writeFileAtomic(path, []byte(content), 0o644); err != nil {
			return added, skipped, err
		}
		added++
	}
	return added, skipped, nil
}
