//go:build !js && !android && !ios

package workbench

// The prompt library: a folder of JSON or YAML packs the app seeds once
// with a starter set. A prompt is inserted into the composer; the library
// is read again when it opens, so a hand-edited pack shows up at once.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"example.com/pideck/assets"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
	yaml "go.yaml.in/yaml/v3"
)

// promptItem is one prompt in the library.
type promptItem struct {
	ID       string
	Title    string
	Body     string
	Category string
	Tags     []string
	Source   string
}

// promptPackEntry is one prompt in a pack. Prompt is an alias for Body,
// so a shared file can use whichever name it likes.
type promptPackEntry struct {
	Slug     string   `yaml:"slug" json:"slug"`
	Title    string   `yaml:"title" json:"title"`
	Body     string   `yaml:"body" json:"body"`
	Prompt   string   `yaml:"prompt" json:"prompt"`
	Category string   `yaml:"category" json:"category"`
	Tags     []string `yaml:"tags" json:"tags"`
}

// promptPack is one file's prompts.
type promptPack struct {
	Name    string            `yaml:"name" json:"name"`
	Prompts []promptPackEntry `yaml:"prompts" json:"prompts"`
}

// promptsDir is the folder the library lives in.
func (a *app) promptsDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "prompts")
}

// ensurePromptLibrary seeds the starter pack the first time only: after
// that the folder is the user's.
func (a *app) ensurePromptLibrary() {
	dir := a.promptsDir()
	if dir == "" {
		return
	}
	if _, err := os.Stat(dir); err == nil {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "starter.json"), assets.StarterPrompts, 0o644)
}

// loadPrompts reads every pack in the folder.
func (a *app) loadPrompts() []promptItem {
	dir := a.promptsDir()
	if dir == "" {
		return nil
	}
	entries, _ := os.ReadDir(dir)
	var out []promptItem
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext != ".json" && ext != ".yaml" && ext != ".yml" {
			continue
		}
		path := filepath.Join(dir, e.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var pack promptPack
		if yaml.Unmarshal(raw, &pack) != nil {
			continue
		}
		base := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		for i, p := range pack.Prompts {
			title := strings.TrimSpace(p.Title)
			body := strings.TrimSpace(p.Body)
			if title == "" || body == "" {
				continue
			}
			category := firstNonEmpty(strings.TrimSpace(p.Category), pack.Name, base)
			out = append(out, promptItem{
				ID:       fmt.Sprintf("%s:%d", base, i),
				Title:    title,
				Body:     body,
				Category: category,
				Tags:     p.Tags,
				Source:   path,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	return out
}

// fetchPromptPack downloads a shared pack.
func fetchPromptPack(rawURL string) (promptPack, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == communityPromptsURL {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		raw, err := downloadCatalogData(ctx, rawURL, 16<<20)
		if err != nil {
			return promptPack{}, err
		}
		return parseCommunityPrompts(raw)
	}
	if !strings.HasPrefix(rawURL, "https://") && !strings.HasPrefix(rawURL, "http://") {
		return promptPack{}, errors.New("只支持 http(s) 链接")
	}
	resp, err := appHTTPClient.Get(rawURL)
	if err != nil {
		return promptPack{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return promptPack{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	limit := int64(2 << 20)
	if rawURL == communityPromptsURL {
		limit = 16 << 20
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return promptPack{}, err
	}
	if int64(len(raw)) > limit {
		return promptPack{}, errors.New("prompt pack exceeds size limit")
	}
	u, _ := url.Parse(rawURL)
	if u != nil && strings.HasSuffix(strings.ToLower(u.Path), ".csv") {
		return parseCommunityPrompts(raw)
	}
	return parsePromptPack(raw)
}

// parsePromptPack reads an object or a bare array of prompts.
func parsePromptPack(raw []byte) (promptPack, error) {
	var pack promptPack
	if yaml.Unmarshal(raw, &pack) == nil && len(pack.Prompts) > 0 {
		pack = normalizePromptPack(pack)
		if len(pack.Prompts) == 0 {
			return promptPack{}, errors.New("提示词包是空的")
		}
		return pack, nil
	}
	var list []promptPackEntry
	if yaml.Unmarshal(raw, &list) != nil || len(list) == 0 {
		return promptPack{}, errors.New("不是提示词包")
	}
	pack.Prompts = list
	pack = normalizePromptPack(pack)
	if len(pack.Prompts) == 0 {
		return promptPack{}, errors.New("提示词包是空的")
	}
	return pack, nil
}

// normalizePromptPack fills Body from Prompt, trims, and drops empty or
// over-long entries.
func normalizePromptPack(pack promptPack) promptPack {
	pack.Name = strings.TrimSpace(pack.Name)
	var out []promptPackEntry
	for _, p := range pack.Prompts {
		p.Title = strings.TrimSpace(p.Title)
		p.Body = strings.TrimSpace(firstNonEmpty(p.Body, p.Prompt))
		p.Prompt = ""
		p.Category = strings.TrimSpace(p.Category)
		if p.Title == "" || p.Body == "" {
			continue
		}
		p.Title = viewkit.FirstLine(p.Title, 80)
		out = append(out, p)
		if len(out) >= 200 {
			break
		}
	}
	pack.Prompts = out
	return pack
}

// importPromptPack merges small packs into prompts/user.json and keeps
// large imports in bounded pack files, skipping titles already present.
func (a *app) importPromptPack(pack promptPack) (int, int, error) {
	dir := a.promptsDir()
	if dir == "" {
		return 0, 0, errors.New("找不到提示词目录")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, 0, err
	}
	path := filepath.Join(dir, "user.json")
	var user promptPack
	if raw, err := os.ReadFile(path); err == nil {
		if yaml.Unmarshal(raw, &user) != nil {
			return 0, 0, errors.New("user.json 不是有效的提示词文件")
		}
	}
	if user.Name == "" {
		user.Name = "我的提示词"
	}
	originalCount := len(user.Prompts)
	seen := map[string]bool{}
	for _, p := range a.loadPrompts() {
		seen[strings.ToLower(p.Title)] = true
	}
	added, skipped := 0, 0
	for _, p := range pack.Prompts {
		key := strings.ToLower(p.Title)
		if seen[key] {
			skipped++
			continue
		}
		seen[key] = true
		if p.Category == "" {
			p.Category = "导入"
		}
		user.Prompts = append(user.Prompts, p)
		added++
	}
	if added == 0 {
		return 0, skipped, nil
	}
	raw, err := json.MarshalIndent(user, "", "  ")
	if err != nil {
		return 0, skipped, err
	}
	raw = append(raw, '\n')
	if len(raw) > importedPromptPartLimit {
		if err := writeImportedPromptParts(dir, promptPack{Name: pack.Name, Prompts: user.Prompts[originalCount:]}); err != nil {
			return 0, skipped, err
		}
		return added, skipped, nil
	}
	if err := writeFileAtomic(path, raw, 0o644); err != nil {
		return 0, skipped, err
	}
	return added, skipped, nil
}

// openPromptLibrary reads the packs and shows the dialog.
func (a *app) openPromptLibrary() {
	if a.st == nil {
		return
	}
	a.promptQuery.Set("")
	a.promptCat.Set("")
	a.promptWindow.Set(80)
	a.promptOpen.Set(true)
	if a.promptLoading.GetUntracked() {
		return
	}
	a.promptLoading.Set(true)
	go func() {
		a.ensurePromptLibrary()
		list := a.loadPrompts()
		a.cx.Post(func() {
			a.prompts.Set(list)
			a.promptLoading.Set(false)
		})
	}()
}

// insertPrompt puts a prompt in the active composer, or the clipboard
// when no session is open.
func (a *app) insertPrompt(p promptItem) {
	s := a.active()
	if s == nil {
		a.copyText(p.Body, "提示词")
		a.promptOpen.Set(false)
		return
	}
	s.draft.Set(p.Body)
	a.promptOpen.Set(false)
	a.toast(ui.ToastInfo, "提示词已放进输入框", p.Title)
}

// saveDraftPrompt keeps the active draft as a prompt in the user's pack.
func (a *app) saveDraftPrompt() {
	s := a.active()
	if s == nil {
		return
	}
	body := strings.TrimSpace(s.draft.GetUntracked())
	if body == "" {
		a.toast(ui.ToastInfo, "输入框是空的", "先写一段想留下的提示词。")
		return
	}
	dir := a.promptsDir()
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "保存提示词失败", err.Error())
		return
	}
	path := filepath.Join(dir, "user.json")
	var pack promptPack
	if raw, err := os.ReadFile(path); err == nil {
		if yaml.Unmarshal(raw, &pack) != nil {
			a.toast(ui.ToastError, "user.json 不是有效的提示词文件", "")
			return
		}
	}
	if pack.Name == "" {
		pack.Name = "我的提示词"
	}
	entry := promptPackEntry{}
	entry.Title = viewkit.FirstLine(body, 40)
	entry.Body = body
	entry.Category = "我的"
	pack.Prompts = append(pack.Prompts, entry)
	raw, err := json.MarshalIndent(pack, "", "  ")
	if err != nil {
		a.toast(ui.ToastError, "保存提示词失败", err.Error())
		return
	}
	raw = append(raw, '\n')
	if err := writeFileAtomic(path, raw, 0o644); err != nil {
		a.toast(ui.ToastError, "保存提示词失败", err.Error())
		return
	}
	a.prompts.Set(a.loadPrompts())
	a.toast(ui.ToastSuccess, "已保存提示词", entry.Title)
}

// promptCategories lists the categories in the library, sorted.
func promptCategories(list []promptItem) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range list {
		if !seen[p.Category] {
			seen[p.Category] = true
			out = append(out, p.Category)
		}
	}
	sort.Strings(out)
	return out
}

// filterPrompts keeps the prompts matching a category and a query.
func filterPrompts(list []promptItem, category, query string) []promptItem {
	query = strings.ToLower(strings.TrimSpace(query))
	var out []promptItem
	for _, p := range list {
		if category != "" && p.Category != category {
			continue
		}
		if query != "" {
			hay := strings.ToLower(p.Title + "\n" + p.Body + "\n" + strings.Join(p.Tags, " "))
			if !strings.Contains(hay, query) {
				continue
			}
		}
		out = append(out, p)
	}
	return out
}
