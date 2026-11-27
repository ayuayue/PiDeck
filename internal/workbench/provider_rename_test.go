//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func providerRenameFixture(t *testing.T, bodies map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	t.Setenv("PIDECK_V2_HOME", filepath.Join(dir, "app"))
	for name, body := range bodies {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func providerRenameRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func providerRenameDecode(t *testing.T, data []byte) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		t.Fatal("invalid result JSON")
	}
	return root
}

func TestRenameProviderConfigPreservesCompleteDocuments(t *testing.T) {
	bodies := map[string]string{
		"models.json":       `{"future":{"large":9007199254740993},"providers":{"acme":{"apiKey":"  model key  ","future":{"nested":[null,true,1e999]},"models":[{"id":"one","extra":{"keep":true}}]},"other":{"models":[]}}}`,
		"auth.json":         `{"acme":{"type":"oauth","access":"  access token  ","refresh":" refresh token \n ","expires":9007199254740993,"future":{"keep":true}},"other":{"type":"api_key","key":" untouched "}}`,
		"usage-probes.json": `{"providers":{"acme":{"apiKey":"  usage key  ","cookie":" cookie ","future":[{"keep":1}]},"other":{"enabled":false}},"future":{"keep":true},"probes":[]}`,
		"settings.json":     `{"defaultProvider":"acme","defaultModel":"one","modelThinkingLevels":{"acme/one":"high","acme/with/slash":"minimal","acme-extra/one":"low","other/one":"off"},"future":{"keep":[null]}}`,
	}
	dir := providerRenameFixture(t, bodies)
	if err := renameProviderConfig("acme", "renamed"); err != nil {
		t.Fatal(err)
	}
	for name, body := range bodies {
		expected := strings.ReplaceAll(body, `"acme"`, `"renamed"`)
		expected = strings.ReplaceAll(expected, `"acme/`, `"renamed/`)
		actual := providerRenameRead(t, filepath.Join(dir, name))
		if !reflect.DeepEqual(providerRenameDecode(t, actual), providerRenameDecode(t, []byte(expected))) {
			t.Errorf("%s: changed unowned fields or failed to migrate references", name)
		}
	}
}

func TestRenameProviderConfigRejectsConflictOrDamageWithoutWrites(t *testing.T) {
	cases := []struct {
		name, file, body string
	}{
		{"models syntax", "models.json", `{"providers":`},
		{"models null", "models.json", `null`},
		{"models array", "models.json", `[]`},
		{"models missing providers", "models.json", `{}`},
		{"models providers null", "models.json", `{"providers":null}`},
		{"models providers array", "models.json", `{"providers":[]}`},
		{"models entry null", "models.json", `{"providers":{"acme":null}}`},
		{"models array field", "models.json", `{"providers":{"acme":{"models":{}}}}`},
		{"models unrelated entry", "models.json", `{"providers":{"acme":{},"other":false}}`},
		{"models missing source", "models.json", `{"providers":{"other":{}}}`},
		{"models target", "models.json", `{"providers":{"acme":{},"renamed":{}}}`},
		{"models duplicate", "models.json", `{"providers":{"acme":{},"acme":{}}}`},
		{"models nested duplicate", "models.json", `{"providers":{"acme":{"future":{"x":1,"x":2}}}}`},
		{"auth empty", "auth.json", ``},
		{"auth null", "auth.json", `null`},
		{"auth array", "auth.json", `[]`},
		{"auth scalar entry", "auth.json", `{"acme":"credential"}`},
		{"auth unrelated entry", "auth.json", `{"acme":{},"other":null}`},
		{"auth target", "auth.json", `{"acme":{"type":"oauth"},"renamed":{}}`},
		{"auth target without source", "auth.json", `{"renamed":{"type":"oauth"}}`},
		{"auth duplicate", "auth.json", `{"acme":{"access":"first","access":"second"}}`},
		{"auth trailing", "auth.json", `{} {}`},
		{"usage syntax", "usage-probes.json", `broken`},
		{"usage root array", "usage-probes.json", `[]`},
		{"usage root null", "usage-probes.json", `null`},
		{"usage providers null", "usage-probes.json", `{"providers":null}`},
		{"usage providers array", "usage-probes.json", `{"providers":[]}`},
		{"usage scalar entry", "usage-probes.json", `{"providers":{"acme":true}}`},
		{"usage unrelated entry", "usage-probes.json", `{"providers":{"acme":{},"other":null}}`},
		{"usage target", "usage-probes.json", `{"providers":{"acme":{},"renamed":{}}}`},
		{"usage target without source", "usage-probes.json", `{"providers":{"renamed":{}}}`},
		{"settings syntax", "settings.json", `{`},
		{"settings null", "settings.json", `null`},
		{"settings array", "settings.json", `[]`},
		{"settings levels null", "settings.json", `{"modelThinkingLevels":null}`},
		{"settings levels array", "settings.json", `{"modelThinkingLevels":[]}`},
		{"settings level object", "settings.json", `{"modelThinkingLevels":{"acme/one":{}}}`},
		{"settings unrelated level", "settings.json", `{"modelThinkingLevels":{"other/one":null}}`},
		{"settings default type", "settings.json", `{"defaultProvider":false}`},
		{"settings target", "settings.json", `{"modelThinkingLevels":{"acme/one":"high","renamed/one":"low"}}`},
		{"settings equal target", "settings.json", `{"modelThinkingLevels":{"acme/one":"high","renamed/one":"high"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bodies := map[string]string{
				"models.json":       `{"providers":{"acme":{"models":[]}}}`,
				"auth.json":         `{"acme":{"type":"oauth","access":"  preserved  ","refresh":" original "}}`,
				"usage-probes.json": `{"providers":{"acme":{"apiKey":" original "}}}`,
				"settings.json":     `{"defaultProvider":"acme","modelThinkingLevels":{"acme/one":"high"}}`,
			}
			bodies[tc.file] = tc.body
			dir := providerRenameFixture(t, bodies)
			if err := renameProviderConfig("acme", "renamed"); err == nil {
				t.Fatal("accepted conflicting or malformed configuration")
			}
			for name, body := range bodies {
				if !bytes.Equal(providerRenameRead(t, filepath.Join(dir, name)), []byte(body)) {
					t.Errorf("%s changed despite validation failure", name)
				}
			}
		})
	}
}

func TestRenameProviderConfigRejectsInvalidIDs(t *testing.T) {
	body := `{"providers":{"acme":{"models":[]}}}`
	dir := providerRenameFixture(t, map[string]string{"models.json": body})
	for _, id := range []string{"", " acme", "acme ", "with/slash", `with\backslash`, "with:colon", "供应商", "line\nbreak"} {
		for _, pair := range [][2]string{{id, "renamed"}, {"acme", id}} {
			if err := renameProviderConfig(pair[0], pair[1]); err == nil {
				t.Fatal("accepted invalid provider ID")
			}
		}
	}
	if err := renameProviderConfig("acme", "acme"); err == nil {
		t.Fatal("accepted identical provider IDs")
	}
	if string(providerRenameRead(t, filepath.Join(dir, "models.json"))) != body {
		t.Fatal("invalid ID changed configuration")
	}
}

func TestRenameProviderConfigDoesNotCreateOptionalFiles(t *testing.T) {
	dir := providerRenameFixture(t, map[string]string{"models.json": `{"providers":{"Acme_1.2-x":{"models":[]}}}`})
	if err := renameProviderConfig("Acme_1.2-x", "New_2.3-y"); err != nil {
		t.Fatal(err)
	}
	root := providerRenameDecode(t, providerRenameRead(t, filepath.Join(dir, "models.json")))
	providers := root["providers"].(map[string]any)
	if _, exists := providers["New_2.3-y"]; !exists || len(providers) != 1 {
		t.Fatal("models entry did not move")
	}
	for _, name := range []string{"auth.json", "usage-probes.json", "settings.json", "auth.json.lock"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("unexpected optional file or lock: %s", name)
		}
	}
}

func TestRenameProviderConfigKeepsUnchangedOptionalBytes(t *testing.T) {
	bodies := map[string]string{
		"models.json":       `{"providers":{"acme":{}}}`,
		"auth.json":         " {\n  \"other\": {\"type\":\"oauth\",\"access\":\" untouched \"}\n}\n",
		"usage-probes.json": " {\"future\":true}\n",
		"settings.json":     " {\"defaultProvider\":\"other\",\"modelThinkingLevels\":{\"acme-extra/one\":\"low\",\"renamed/unrelated\":\"high\"}}\n",
	}
	dir := providerRenameFixture(t, bodies)
	if err := renameProviderConfig("acme", "renamed"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"auth.json", "usage-probes.json", "settings.json"} {
		if string(providerRenameRead(t, filepath.Join(dir, name))) != bodies[name] {
			t.Errorf("unchanged %s was rewritten", name)
		}
	}
}

func providerRenameWriteFixture(t *testing.T, count int) []providerRenameFile {
	t.Helper()
	dir := providerRenameFixture(t, nil)
	var files []providerRenameFile
	for i := 0; i < count; i++ {
		path := filepath.Join(dir, string(rune('a'+i))+".json")
		before := []byte(" {\"original\": true}\n")
		if err := os.WriteFile(path, before, 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, providerRenameFile{path: path, before: before, after: []byte("{\"renamed\":true}\n"), exists: true})
	}
	return files
}

func TestProviderRenameWritesRejectExternalChanges(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "changed", true: "created optional"}[missing], func(t *testing.T) {
			files := providerRenameWriteFixture(t, 2)
			if missing {
				files[1].exists, files[1].before, files[1].after = false, nil, nil
			}
			external := []byte("{\"external\":true}\n")
			if err := os.WriteFile(files[1].path, external, 0o600); err != nil {
				t.Fatal(err)
			}
			calls := 0
			err := writeProviderRenameFiles(files, func(string, []byte, os.FileMode) error { calls++; return nil })
			if err == nil || calls != 0 {
				t.Fatal("stale snapshot allowed a write")
			}
			if !bytes.Equal(providerRenameRead(t, files[0].path), files[0].before) || !bytes.Equal(providerRenameRead(t, files[1].path), external) {
				t.Fatal("external-change rejection modified files")
			}
		})
	}
}

func TestProviderRenameWritesRollBackOnMidWriteFailure(t *testing.T) {
	files := providerRenameWriteFixture(t, 3)
	failure := errors.New("injected write failure")
	calls := 0
	err := writeProviderRenameFiles(files, func(path string, data []byte, mode os.FileMode) error {
		calls++
		if mode != 0o600 {
			t.Fatal("configuration write was not private")
		}
		if calls == 3 {
			return failure
		}
		return writeFileAtomic(path, data, mode)
	})
	if !errors.Is(err, failure) || calls != 5 {
		t.Fatal("failure was lost or earlier writes were not rolled back")
	}
	for _, file := range files {
		if !bytes.Equal(providerRenameRead(t, file.path), file.before) {
			t.Fatal("rollback did not restore original bytes")
		}
	}
}

func TestProviderRenameWritesJoinRollbackFailures(t *testing.T) {
	files := providerRenameWriteFixture(t, 3)
	writeFailure, rollbackFailure := errors.New("write failure"), errors.New("rollback failure")
	calls := 0
	err := writeProviderRenameFiles(files, func(path string, data []byte, mode os.FileMode) error {
		calls++
		switch calls {
		case 3:
			return writeFailure
		case 4:
			return rollbackFailure
		default:
			return writeFileAtomic(path, data, mode)
		}
	})
	if !errors.Is(err, writeFailure) || !errors.Is(err, rollbackFailure) || calls != 5 {
		t.Fatal("rollback errors were lost or rollback stopped prematurely")
	}
	if !bytes.Equal(providerRenameRead(t, files[0].path), files[0].before) || !bytes.Equal(providerRenameRead(t, files[1].path), files[1].after) {
		t.Fatal("rollback failure state was unexpected")
	}
}

func TestProviderRenameWritesRecheckBeforeEachReplacement(t *testing.T) {
	files := providerRenameWriteFixture(t, 2)
	external := []byte("{\"external\":true}\n")
	calls := 0
	err := writeProviderRenameFiles(files, func(path string, data []byte, mode os.FileMode) error {
		calls++
		if err := writeFileAtomic(path, data, mode); err != nil {
			return err
		}
		if calls == 1 {
			return os.WriteFile(files[1].path, external, 0o600)
		}
		return nil
	})
	if err == nil || calls != 2 {
		t.Fatal("missing pre-write recheck or rollback")
	}
	if !bytes.Equal(providerRenameRead(t, files[0].path), files[0].before) || !bytes.Equal(providerRenameRead(t, files[1].path), external) {
		t.Fatal("external update was overwritten or prior write was not restored")
	}
}

func TestProviderRenameRollbackPreservesExternalChanges(t *testing.T) {
	files := providerRenameWriteFixture(t, 2)
	external := []byte("{\"external\":true}\n")
	failure := errors.New("injected write failure")
	calls := 0
	err := writeProviderRenameFiles(files, func(path string, data []byte, mode os.FileMode) error {
		calls++
		if calls == 2 {
			if err := os.WriteFile(files[0].path, external, 0o600); err != nil {
				t.Fatal(err)
			}
			return failure
		}
		return writeFileAtomic(path, data, mode)
	})
	if !errors.Is(err, failure) || !strings.Contains(err.Error(), "rollback a.json failed") || calls != 2 {
		t.Fatal("external change during rollback was not reported")
	}
	if !bytes.Equal(providerRenameRead(t, files[0].path), external) {
		t.Fatal("rollback overwrote external change")
	}
}
