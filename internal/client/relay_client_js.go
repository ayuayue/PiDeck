//go:build js

package client

// A browser page cannot open a raw socket, so a relay pairing link is
// refused there; the native phone apps carry it.

import (
	"errors"

	"example.com/pideck-lite/internal/relaywire"
)

func newRelayClient(link relaywire.Link, source string) (*remoteClient, string, error) {
	return nil, "", errors.New("浏览器里暂不支持中继连接，请用手机 App")
}
