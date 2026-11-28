package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"encoding/json"

	"github.com/nsgo-dev/nsgo/core"
)

func loadMobileSaved(cx *core.Scope) mobileSaved {
	raw, err := readMobileStore(cx)
	if err != nil {
		return mobileSaved{}
	}
	var saved mobileSaved
	if json.Unmarshal(raw, &saved) != nil {
		return mobileSaved{}
	}
	return saved
}

// rememberConnection puts one server first in the list, keeping five.
func rememberConnection(list []mobileRecent, item mobileRecent) mobileSaved {
	out := make([]mobileRecent, 0, 5)
	out = append(out, item)
	for _, old := range list {
		if old.Server == item.Server || len(out) >= 5 {
			continue
		}
		out = append(out, old)
	}
	return mobileSaved{Server: item.Server, Token: item.Token, Recent: out}
}

func saveMobileSaved(cx *core.Scope, saved mobileSaved) error {
	raw, err := json.Marshal(saved)
	if err != nil {
		return err
	}
	return writeMobileStore(cx, raw)
}
