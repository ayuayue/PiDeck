//go:build !js && !android && !ios

package workbench

import (
	"embed"
	"encoding/json"
)

// The same manifests are the installed examples and their market metadata.
// They are bundled only with the desktop host and do not enter WebAssembly.
//
//go:embed plugin_examples/*.json
var pluginExamples embed.FS

func builtinPluginExamples() []marketEntry {
	files, err := pluginExamples.ReadDir("plugin_examples")
	if err != nil {
		return nil
	}
	var entries []marketEntry
	for _, file := range files {
		raw, err := pluginExamples.ReadFile("plugin_examples/" + file.Name())
		if err != nil {
			continue
		}
		var p plugin
		if json.Unmarshal(raw, &p) != nil {
			continue
		}
		entries = append(entries, marketEntry{ID: p.ID, Name: p.Name, Description: p.Description,
			Version: p.Version, Author: p.Author, Runtime: p.Runtime, Builtin: true})
	}
	return entries
}
