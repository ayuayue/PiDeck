//go:build !js

package client

// The phone's side of the outbound relay: the pairing link names a
// WebSocket address and the desktop certificate's fingerprint. The phone
// wraps that socket in TLS itself, so the relay only sees ciphertext, and
// the ordinary HTTP client above it talks to the desktop unchanged.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"

	"example.com/pideck/internal/relaywire"
	"golang.org/x/net/websocket"
)

// relayBase is the host the HTTP client names in its requests; the dialer
// ignores it and opens the tunnel instead.
const relayBase = "http://relay.pideck.invalid"

// newRelayClient builds a remote client that reaches the desktop through
// the relay in a pairing link.
func newRelayClient(link relaywire.Link, source string) (*remoteClient, string, error) {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialRelay(ctx, link)
		},
		MaxConnsPerHost:     1,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	return &remoteClient{
		base:   relayBase,
		source: source,
		token:  link.Token,
		http:   &http.Client{Timeout: 12 * time.Second, Transport: tr},
	}, link.Token, nil
}

// dialRelay opens the tunnel and pins the desktop's certificate.
func dialRelay(ctx context.Context, link relaywire.Link) (net.Conn, error) {
	origin, _ := url.Parse("http://pideck-relay.local")
	cfg, err := websocket.NewConfig(link.URL(relaywire.RolePhone), origin.String())
	if err != nil {
		return nil, err
	}
	cfg.Dialer = &net.Dialer{Timeout: 10 * time.Second}

	type dialed struct {
		conn *websocket.Conn
		err  error
	}
	ch := make(chan dialed, 1)
	go func() {
		conn, err := websocket.DialConfig(cfg)
		ch <- dialed{conn, err}
	}()
	var ws *websocket.Conn
	select {
	case result := <-ch:
		if result.err != nil {
			return nil, errors.New("连不上中继：" + relaywire.DialError(result.err))
		}
		ws = result.conn
	case <-ctx.Done():
		// The dial may still finish; close what it returns.
		go func() {
			if result := <-ch; result.conn != nil {
				_ = result.conn.Close()
			}
		}()
		return nil, ctx.Err()
	}

	// The TLS stream is binary; a text frame would be re-encoded by a
	// proxy that validates UTF-8.
	ws.PayloadType = websocket.BinaryFrame

	tunnel := tls.Client(ws, &tls.Config{
		ServerName:         "pideck-relay",
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true, // The pairing link pins the certificate.
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("中继没有返回电脑的证书")
			}
			sum := sha256.Sum256(raw[0])
			got := base64.RawURLEncoding.EncodeToString(sum[:])
			if subtle.ConstantTimeCompare([]byte(got), []byte(link.Fingerprint)) != 1 {
				return errors.New("证书和配对链接不一致，可能连到了另一台电脑")
			}
			return nil
		},
	})
	if err := tunnel.HandshakeContext(ctx); err != nil {
		_ = ws.Close()
		return nil, errors.New("中继握手失败：" + err.Error())
	}
	return tunnel, nil
}
