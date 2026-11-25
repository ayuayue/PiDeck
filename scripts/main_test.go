package main

import (
	"testing"

	"example.com/pideck-v2/internal/appinfo"
)

func TestReadManifestMissingUsesAppVersion(t *testing.T) {
	name, id, version := readManifest(t.TempDir())
	if name != "PiDeck V2" || id != fallbackID || version != appinfo.Version {
		t.Fatalf("manifest fallback = (%q, %q, %q), want (%q, %q, %q)", name, id, version,
			"PiDeck V2", fallbackID, appinfo.Version)
	}
}
