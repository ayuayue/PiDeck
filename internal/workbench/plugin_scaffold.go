//go:build !js && !android && !ios

package workbench

// Creating a plugin: a folder whose manifest already works, so every
// extension point is one press away.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// pluginIDPattern is what a plugin's folder may be called.
var pluginIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)

// pluginIDProblem says why an id cannot be used, empty when it can.
func pluginIDProblem(id string) string {
	switch {
	case id == "":
		return "填一个插件 id。"
	case !pluginIDPattern.MatchString(id):
		return "插件 id 只能用小写字母、数字和连字符，2–32 位，字母开头。"
	}
	return ""
}

// pluginTemplate is a manifest with one command and one setting, which is
// enough to show how the rest of contributes fits together.
func pluginTemplate(id, name, desc string) ([]byte, error) {
	if strings.TrimSpace(desc) == "" {
		desc = name + " 的示例插件。"
	}
	doc := map[string]any{
		"id": id, "name": name, "version": "0.1.0", "description": desc,
		"contributes": map[string]any{
			"commands": []any{map[string]any{
				"id": "hello", "title": "你好，" + name, "description": "插件命令的示例", "group": name,
				"action": map[string]any{"type": "prompt", "prompt": "请介绍一下这个项目。"},
			}},
			"settings": []any{map[string]any{
				"key": "greeting", "label": "问候语", "type": "string", "default": "你好",
			}},
		},
	}
	return json.MarshalIndent(doc, "", "  ")
}

// createPlugin writes a new plugin's folder, manifest and readme.
func (a *app) createPlugin(id, name, desc string) (string, error) {
	id, name = strings.TrimSpace(id), strings.TrimSpace(name)
	if problem := pluginIDProblem(id); problem != "" {
		return "", errors.New(problem)
	}
	if name == "" {
		return "", errors.New("填一个插件名。")
	}
	dir := a.pluginsDir()
	if dir == "" {
		return "", errors.New("没有数据目录")
	}
	path := filepath.Join(dir, id)
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("插件「%s」已经存在", id)
	}
	raw, err := pluginTemplate(id, name, desc)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(path, "plugin.json"), append(raw, '\n'), 0o644); err != nil {
		return "", err
	}
	readme := "# " + name + "\n\n" + strings.TrimSpace(desc) + "\n\n" +
		"这个文件夹里的 `plugin.json` 就是这个插件：命令、设置、主题、键位、钩子和智能体都写在 `contributes` 里。\n" +
		"改完保存，回到 PiDeck Lite 执行「重新加载」，命令面板里就能看到它。\n"
	_ = os.WriteFile(filepath.Join(path, "README.md"), []byte(readme), 0o644)
	return path, nil
}
