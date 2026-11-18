//go:build !js && !android && !ios

package workbench

// Checks the settings schema matches the config struct.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestSettingsSchema(t *testing.T) {
	keys := map[string]bool{}
	valid := map[string]bool{"bool": true, "enum": true, "number": true, "text": true}
	for _, f := range appSettingFields {
		if f.Key == "" || keys[f.Key] {
			t.Fatalf("duplicate or empty key: %+v", f)
		}
		keys[f.Key] = true
		if !valid[f.Type] {
			t.Fatalf("%s has type %q", f.Key, f.Type)
		}
		if f.Type == "enum" {
			found := false
			for _, v := range f.Values {
				if v == fmt.Sprint(f.Default) {
					found = true
				}
			}
			if !found {
				t.Fatalf("%s default %v is not one of %v", f.Key, f.Default, f.Values)
			}
		}
		if f.Min != nil && f.Max != nil && *f.Min > *f.Max {
			t.Fatalf("%s has min %d over max %d", f.Key, *f.Min, *f.Max)
		}
	}

	// Every key is a field of the config struct.
	tags := map[string]bool{}
	typ := reflect.TypeOf(config{})
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name != "" && name != "-" {
			tags[name] = true
		}
	}
	for key := range keys {
		if !tags[key] {
			t.Fatalf("schema key %q is not a config field", key)
		}
	}
}

func TestSettingsSchemaJSON(t *testing.T) {
	raw := settingsSchemaJSON()
	var out struct {
		Version int            `json:"version"`
		Fields  []settingField `json:"fields"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Version != configVersion || len(out.Fields) != len(appSettingFields) {
		t.Fatalf("schema = %+v", out)
	}
}
