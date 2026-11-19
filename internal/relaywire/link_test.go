package relaywire

import (
	"errors"
	"strings"
	"testing"
)

func TestLinkRoundTrip(t *testing.T) {
	link := Link{
		Relay:       "wss://relay.example.com/v1/tunnel",
		Env:         strings.Repeat("a", 48),
		Key:         strings.Repeat("b", 48),
		Fingerprint: strings.Repeat("c", 43),
		Token:       strings.Repeat("d", 48),
	}
	text := link.String()
	if !IsLink(text) {
		t.Fatalf("link not recognized: %s", text)
	}
	got, err := Parse(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got != link {
		t.Fatalf("round trip = %+v, want %+v", got, link)
	}
	url := got.URL(RolePhone)
	if !strings.Contains(url, "role=phone") || !strings.Contains(url, "env="+link.Env) {
		t.Fatalf("role url = %s", url)
	}
}

func TestParseRejects(t *testing.T) {
	if _, err := Parse("http://192.168.1.8:8787/?token=x"); err != ErrNotLink {
		t.Fatalf("plain address error = %v", err)
	}
	base := Link{
		Relay: "wss://relay.example.com/v1/tunnel", Env: "env-1", Key: "key-1",
		Fingerprint: strings.Repeat("c", 43), Token: "token",
	}
	cases := map[string]Link{
		"no relay":       {Env: base.Env, Key: base.Key, Fingerprint: base.Fingerprint, Token: base.Token},
		"http relay":     {Relay: "https://relay.example.com/v1/tunnel", Env: base.Env, Key: base.Key, Fingerprint: base.Fingerprint, Token: base.Token},
		"no fingerprint": {Relay: base.Relay, Env: base.Env, Key: base.Key, Token: base.Token},
		"short fp":       {Relay: base.Relay, Env: base.Env, Key: base.Key, Fingerprint: "abc", Token: base.Token},
		"bad env":        {Relay: base.Relay, Env: "env 1", Key: base.Key, Fingerprint: base.Fingerprint, Token: base.Token},
	}
	for name, link := range cases {
		if _, err := Parse(link.String()); err != ErrBadLink {
			t.Errorf("%s: error = %v, want ErrBadLink", name, err)
		}
	}
}

func TestDialErrorStripsTheKey(t *testing.T) {
	err := errors.New("websocket.Dial ws://relay/v1/tunnel?env=e&key=SECRET&role=phone: dial tcp: connection refused")
	got := DialError(err)
	if strings.Contains(got, "SECRET") {
		t.Fatalf("error kept the key: %q", got)
	}
	if !strings.Contains(got, "connection refused") {
		t.Fatalf("error lost the reason: %q", got)
	}
}

// TestParseTrimsChatPunctuation checks that a link copied out of a chat
// with a sentence mark or quotes still parses.
func TestParseTrimsChatPunctuation(t *testing.T) {
	link := Link{
		Relay:       "wss://relay.example.com/v1/tunnel",
		Env:         strings.Repeat("a", 48),
		Key:         strings.Repeat("b", 48),
		Fingerprint: strings.Repeat("c", 43),
		Token:       strings.Repeat("d", 24),
	}
	for _, suffix := range []string{"。", "，", ",", ".", ";", "！", "?", "\"", "”"} {
		got, err := Parse(link.String() + suffix)
		if err != nil {
			t.Errorf("suffix %q: %v", suffix, err)
			continue
		}
		if got.Relay != link.Relay || got.Env != link.Env {
			t.Errorf("suffix %q: %+v", suffix, got)
		}
	}
	if _, err := Parse("<" + link.String() + ">"); err != nil {
		t.Errorf("bracketed link: %v", err)
	}
}
