//go:build !js && !android && !ios

package workbench

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
)

const (
	settingsSyncFile  = "pideck-v2-settings.pidecksync"
	settingsSyncMagic = "PDLSYNC\x01"
	settingsSyncLimit = backupTotalLimit + 2<<20
	gistSyncLimit     = 720 << 10
)

func settingsSyncCipher(password string, salt []byte) (cipher.AEAD, error) {
	key, err := pbkdf2.Key(sha256.New, password, salt, 600_000, 32)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithRandomNonce(block)
}

func encryptSettings(raw []byte, password string) ([]byte, error) {
	if len(raw) > backupTotalLimit+1<<20 {
		return nil, errors.New(apptext.T("同步包超过大小限制。"))
	}
	if !validSyncPassword(password) {
		return nil, errors.New(apptext.T("请输入至少 12 个字符的加密密码。"))
	}
	header := append([]byte(settingsSyncMagic), make([]byte, 16)...)
	rand.Read(header[len(settingsSyncMagic):])
	aead, err := settingsSyncCipher(password, header[len(settingsSyncMagic):])
	if err != nil {
		return nil, err
	}
	return aead.Seal(bytes.Clone(header), nil, raw, header), nil
}

func validSyncPassword(password string) bool {
	return len(password) <= 512 && utf8.RuneCountInString(password) >= 12
}

func decryptSettings(blob []byte, password string) (*zip.Reader, error) {
	headerLen := len(settingsSyncMagic) + 16
	invalid := errors.New(apptext.T("无法解密设置包，请检查密码和文件。"))
	if len(blob) < headerLen || len(blob) > settingsSyncLimit || !bytes.HasPrefix(blob, []byte(settingsSyncMagic)) || len(password) > 512 {
		return nil, invalid
	}
	aead, err := settingsSyncCipher(password, blob[len(settingsSyncMagic):headerLen])
	if err != nil {
		return nil, err
	}
	raw, err := aead.Open(nil, nil, blob[headerLen:], blob[:headerLen])
	if err != nil {
		return nil, invalid
	}
	return zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
}

type settingsSyncTarget struct {
	kind, path, id, token string
}

func (t settingsSyncTarget) validate(upload bool) error {
	if t.kind == "folder" {
		if t.path == "" || !filepath.IsAbs(t.path) {
			return errors.New(apptext.T("请选择同步目录。"))
		}
		return nil
	}
	if t.token == "" || len(t.token) > 8192 || strings.ContainsAny(t.token, "\r\n\x00") {
		return errors.New(apptext.T("请输入访问令牌。"))
	}
	if (t.id == "" && !upload) || len(t.id) > 160 || strings.ContainsFunc(t.id, func(r rune) bool {
		return (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && r != '-' && r != '_'
	}) {
		return errors.New(apptext.T("请输入有效的远端文件 ID。"))
	}
	return nil
}

func (t settingsSyncTarget) upload(ctx context.Context, blob []byte) (string, error) {
	switch t.kind {
	case "folder":
		return "", writeFileAtomic(filepath.Join(t.path, settingsSyncFile), blob, 0o600)
	case "gist":
		if len(blob) > gistSyncLimit {
			return "", errors.New(apptext.T("Gist 同步包超过 720 KB，请选择其他位置。"))
		}
		path, method := "https://api.github.com/gists", http.MethodPost
		payload := map[string]any{"files": map[string]any{settingsSyncFile: map[string]string{"content": base64.StdEncoding.EncodeToString(blob)}}}
		if t.id == "" {
			payload["public"], payload["description"] = false, "PiDeck V2 encrypted settings"
		} else {
			path, method = path+"/"+t.id, http.MethodPatch
		}
		body, _ := json.Marshal(payload)
		return syncRemoteID(settingsSyncRequest(ctx, method, path, "application/json", t.token, body, 4<<20))
	case "drive":
		path := "https://www.googleapis.com/upload/drive/v3/files"
		if t.id != "" {
			return syncRemoteID(settingsSyncRequest(ctx, http.MethodPatch, path+"/"+t.id+"?uploadType=media&fields=id", "application/octet-stream", t.token, blob, 128<<10))
		}
		var body bytes.Buffer
		parts := multipart.NewWriter(&body)
		meta, _ := json.Marshal(map[string]string{"name": settingsSyncFile, "mimeType": "application/octet-stream"})
		for _, p := range []struct {
			mediaType string
			data      []byte
		}{{"application/json; charset=UTF-8", meta}, {"application/octet-stream", blob}} {
			w, err := parts.CreatePart(textproto.MIMEHeader{"Content-Type": {p.mediaType}})
			if err != nil {
				return "", err
			}
			if _, err := w.Write(p.data); err != nil {
				return "", err
			}
		}
		if err := parts.Close(); err != nil {
			return "", err
		}
		return syncRemoteID(settingsSyncRequest(ctx, http.MethodPost, path+"?uploadType=multipart&fields=id", "multipart/related; boundary="+parts.Boundary(), t.token, body.Bytes(), 128<<10))
	}
	return "", errors.New("unknown sync destination")
}

func syncRemoteID(raw []byte, err error) (string, error) {
	if err != nil {
		return "", err
	}
	var object struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &object) != nil || object.ID == "" {
		return "", errors.New(apptext.T("服务没有返回同步文件 ID。"))
	}
	return object.ID, nil
}

func (t settingsSyncTarget) download(ctx context.Context) ([]byte, error) {
	switch t.kind {
	case "folder":
		f, err := os.Open(filepath.Join(t.path, settingsSyncFile))
		if err != nil {
			return nil, err
		}
		defer f.Close()
		return readSyncSize(f, settingsSyncLimit)
	case "gist":
		raw, err := settingsSyncRequest(ctx, http.MethodGet, "https://api.github.com/gists/"+t.id, "", t.token, nil, 4<<20)
		if err != nil {
			return nil, err
		}
		var gist struct {
			Files map[string]struct {
				Content   string
				Truncated bool
			}
		}
		if json.Unmarshal(raw, &gist) != nil || gist.Files[settingsSyncFile].Content == "" || gist.Files[settingsSyncFile].Truncated {
			return nil, errors.New(apptext.T("Gist 中没有完整的加密设置包。"))
		}
		return base64.StdEncoding.DecodeString(gist.Files[settingsSyncFile].Content)
	case "drive":
		return settingsSyncRequest(ctx, http.MethodGet, "https://www.googleapis.com/drive/v3/files/"+t.id+"?alt=media", "", t.token, nil, settingsSyncLimit)
	}
	return nil, errors.New("unknown sync destination")
}

func readSyncSize(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err == nil && int64(len(data)) > limit {
		return nil, errors.New(apptext.T("同步包超过大小限制。"))
	}
	return data, err
}

func settingsSyncRequest(ctx context.Context, method, address, mediaType, token string, payload []byte, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if mediaType != "" {
		req.Header.Set("Content-Type", mediaType)
	}
	client := http.Client{Transport: appHTTPLongClient.Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return readSyncSize(res.Body, limit)
}
