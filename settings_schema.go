//go:build !js && !android && !ios

package main

// The app's settings as a schema: every field the app writes, its type,
// default and accepted values. The diagnostics bundle carries it, and a
// test keeps it in step with the config.

import (
	"encoding/json"
	"fmt"
)

// settingField declares one app setting.
type settingField struct {
	Key     string   `json:"key"`
	Type    string   `json:"type"` // bool, enum, number, text
	Default any      `json:"default"`
	Values  []string `json:"values,omitempty"`
	Min     *int     `json:"min,omitempty"`
	Max     *int     `json:"max,omitempty"`
}

// intPtr is a number bound.
func intPtr(n int) *int { return &n }

// appSettingFields is the schema of the app's own config.
var appSettingFields = []settingField{
	{Key: "theme", Type: "text", Default: "system"},
	{Key: "logoStyle", Type: "enum", Default: "pi-tui", Values: []string{"", "pi-tui", "classic", "custom"}},
	{Key: "logoCustomImage", Type: "text", Default: ""},
	{Key: "appDisplayName", Type: "text", Default: ""},
	{Key: "language", Type: "enum", Default: "", Values: []string{"", "zh-CN", "zh-TW", "en-US"}},
	{Key: "sessionSort", Type: "enum", Default: "", Values: []string{"", "updated", "name"}},
	{Key: "projectSort", Type: "enum", Default: "", Values: []string{"", "manual", "recent", "created", "title"}},
	{Key: "thinking", Type: "enum", Default: "", Values: []string{"", "off", "low", "medium", "high", "max"}},
	{Key: "terminalHeight", Type: "number", Default: 0, Min: intPtr(120), Max: intPtr(1200)},
	{Key: "chatWidth", Type: "number", Default: 720, Min: intPtr(chatWidthMin), Max: intPtr(chatWidthMax)},
	{Key: "imageCount", Type: "enum", Default: 1, Values: []string{"0", "1", "2", "4"}},
	{Key: "imageProvider", Type: "text", Default: ""},
	{Key: "imageModel", Type: "text", Default: ""},
	{Key: "imageSize", Type: "text", Default: "1024x1024"},
	{Key: "visionProvider", Type: "text", Default: ""},
	{Key: "visionModel", Type: "text", Default: ""},
	{Key: "scanPi", Type: "bool", Default: false},
	{Key: "scanAll", Type: "bool", Default: false},
	{Key: "closeToTray", Type: "bool", Default: false},
	{Key: "notifyOnDone", Type: "bool", Default: false},
	{Key: "notifyOnlyHidden", Type: "bool", Default: false},
	{Key: "petEnabled", Type: "bool", Default: false},
	{Key: "telemetryEnabled", Type: "bool", Default: true},
	{Key: "feishuEnabled", Type: "bool", Default: false},
	{Key: "feishuInbound", Type: "bool", Default: false},
	{Key: "feishuReply", Type: "bool", Default: false},
	{Key: "remoteEnabled", Type: "bool", Default: false},
	{Key: "remotePort", Type: "number", Default: 0, Min: intPtr(1), Max: intPtr(65535)},
	{Key: "proxyApp", Type: "text", Default: ""},
	{Key: "proxyAgent", Type: "text", Default: ""},
	{Key: "proxyBypass", Type: "text", Default: ""},
	{Key: "editorCommand", Type: "text", Default: ""},
	{Key: "editorWrap", Type: "bool", Default: false},
	{Key: "terminalFont", Type: "number", Default: 0, Min: intPtr(8), Max: intPtr(20)},
	{Key: "editorFont", Type: "number", Default: 0, Min: intPtr(11), Max: intPtr(20)},
	{Key: "chatFont", Type: "number", Default: 0, Min: intPtr(chatFontMin), Max: intPtr(chatFontMax)},
	{Key: "chatLine", Type: "number", Default: 0, Min: intPtr(int(chatLineMin * 10)), Max: intPtr(int(chatLineMax * 10))},
	{Key: "inputFont", Type: "number", Default: 0, Min: intPtr(chatFontMin), Max: intPtr(chatFontMax)},
}

// settingsSchema is the schema as the diagnostics bundle carries it.
func settingsSchema() map[string]any {
	return map[string]any{
		"version": configVersion,
		"fields":  appSettingFields,
	}
}

// settingsSchemaJSON encodes the schema.
func settingsSchemaJSON() []byte {
	data, err := json.MarshalIndent(settingsSchema(), "", "  ")
	if err != nil {
		return []byte(fmt.Sprintf(`{"error":%q}`, err.Error()))
	}
	return append(data, '\n')
}
