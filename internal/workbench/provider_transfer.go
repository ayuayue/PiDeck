//go:build !js && !android && !ios

package workbench

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"os"
	"sort"
	"strings"

	"example.com/pideck-v2/internal/apptext"
)

const providerTransferLimit = 8 << 20

type providerTransferPreview struct {
	Providers []string
	Models    int
	Conflicts []string
}

func previewProviderImport(input string) (providerTransferPreview, error) {
	incoming, err := parseProviderTransfer(input)
	if err != nil {
		return providerTransferPreview{}, err
	}
	modelsFileMu.Lock()
	defer modelsFileMu.Unlock()
	current, err := readProviderTransferDocument(true)
	if err != nil {
		return providerTransferPreview{}, err
	}
	preview := providerTransferPreview{Providers: []string{}, Conflicts: []string{}}
	for id, value := range incoming {
		preview.Providers = append(preview.Providers, id)
		preview.Models += len(value.(map[string]any)["models"].([]any))
		if _, exists := current[id]; exists {
			preview.Conflicts = append(preview.Conflicts, id)
		}
	}
	sort.Strings(preview.Providers)
	sort.Strings(preview.Conflicts)
	return preview, nil
}

func importProviderConfigs(input string, replace bool) error {
	incoming, err := parseProviderTransfer(input)
	if err != nil {
		return err
	}
	return mutateModelsDocument(true, func(providers map[string]any) error {
		if !replace {
			for id := range incoming {
				if _, exists := providers[id]; exists {
					return errors.New(apptext.T("供应商已存在，请确认替换后再导入。"))
				}
			}
		}
		for id, provider := range incoming {
			providers[id] = provider
		}
		return nil
	})
}

// Export the models.json shape, never unrelated root data or unselected providers.
func exportProviderConfigs(ids []string, includeSecrets bool) (string, error) {
	if len(ids) == 0 {
		return "", errors.New(apptext.T("请先选择要导出的供应商。"))
	}
	modelsFileMu.Lock()
	defer modelsFileMu.Unlock()
	providers, err := readProviderTransferDocument(false)
	if err != nil {
		return "", err
	}
	selected := map[string]any{}
	for _, id := range ids {
		if !validProviderID(id) {
			return "", errors.New(apptext.T("供应商 ID 只能包含英文字母、数字、点、短横线和下划线。"))
		}
		provider, err := providerDocument(providers, id)
		if err != nil {
			return "", err
		}
		if err := validateTransferProvider(provider); err != nil {
			return "", err
		}
		if !includeSecrets {
			redactProviderTransfer(provider)
		}
		selected[id] = provider
	}
	data, err := json.MarshalIndent(map[string]any{"providers": selected}, "", "  ")
	if err != nil {
		return "", errors.New(apptext.T("供应商配置无法导出为 JSON。"))
	}
	return string(data) + "\n", nil
}

func readProviderTransferDocument(allowMissing bool) (map[string]any, error) {
	file, err := os.Open(modelsJSONPath())
	if allowMissing && errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, errors.New(apptext.T("无法读取 models.json，请检查文件与权限。"))
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, providerTransferLimit+1))
	if err != nil {
		return nil, errors.New(apptext.T("无法读取 models.json，请检查文件与权限。"))
	}
	root, err := decodeTransferObject(string(data))
	if err != nil {
		return nil, err
	}
	providers, ok := root["providers"].(map[string]any)
	if !ok {
		if _, exists := root["providers"]; exists {
			return nil, errors.New(apptext.T("models.json 的 providers 必须是对象。"))
		}
		return map[string]any{}, nil
	}
	return providers, nil
}

// Dev exports Base64-wrapped v1 envelopes. These APIs have no passphrase
// parameter, so encrypted envelopes are explicitly rejected.
func parseProviderTransfer(input string) (map[string]any, error) {
	if len(input) > providerTransferLimit {
		return nil, errors.New(apptext.T("供应商导入内容不能超过 8 MiB。"))
	}
	input = strings.TrimSpace(input)
	encoded := !strings.HasPrefix(input, "{")
	if encoded {
		data, err := base64.StdEncoding.DecodeString(input)
		if err != nil {
			return nil, errors.New(apptext.T("请输入完整的 models.json 或有效的供应商导出内容。"))
		}
		input = string(data)
	}
	root, err := decodeTransferObject(input)
	if err != nil {
		return nil, err
	}
	if encoded || root["kind"] == "pideck-models-export" {
		if root["kind"] != "pideck-models-export" || root["schemaVersion"] != json.Number("1") {
			return nil, errors.New(apptext.T("供应商导出格式或版本不受支持。"))
		}
		if root["encrypted"] == true {
			return nil, errors.New(apptext.T("暂不支持加密的供应商导入，请先在原客户端导出未加密配置。"))
		}
		if root["encrypted"] != false {
			return nil, errors.New(apptext.T("供应商导出格式或版本不受支持。"))
		}
	}
	providers, ok := root["providers"].(map[string]any)
	if !ok || len(providers) == 0 {
		return nil, errors.New(apptext.T("导入内容的 providers 必须是非空对象。"))
	}
	for id, value := range providers {
		if !validProviderID(id) {
			return nil, errors.New(apptext.T("供应商 ID 只能包含英文字母、数字、点、短横线和下划线。"))
		}
		provider, ok := value.(map[string]any)
		if !ok {
			return nil, errors.New(apptext.T("供应商配置必须是 JSON 对象。"))
		}
		if err := validateTransferProvider(provider); err != nil {
			return nil, err
		}
	}
	return providers, nil
}

func decodeTransferObject(input string) (map[string]any, error) {
	if len(input) > providerTransferLimit {
		return nil, errors.New(apptext.T("供应商导入内容不能超过 8 MiB。"))
	}
	decoder := json.NewDecoder(strings.NewReader(input))
	decoder.UseNumber()
	value, err := readTransferJSON(decoder, 0)
	root, ok := value.(map[string]any)
	if err != nil || !ok {
		return nil, errors.New(apptext.T("models.json 不是有效的 JSON 对象。"))
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New(apptext.T("models.json 不是有效的 JSON 对象。"))
	}
	return root, nil
}

// Reject duplicate object keys instead of silently keeping the final value.
func readTransferJSON(decoder *json.Decoder, depth int) (any, error) {
	if depth > 256 {
		return nil, errors.New(apptext.T("供应商配置嵌套过深。"))
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if token == json.Delim('{') {
		object := map[string]any{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if _, exists := object[name]; !ok || exists {
				return nil, errors.New(apptext.T("JSON 对象不能包含重复字段。"))
			}
			object[name], err = readTransferJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
		}
		_, err = decoder.Token()
		return object, err
	}
	if token == json.Delim('[') {
		array := []any{}
		for decoder.More() {
			value, err := readTransferJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		_, err = decoder.Token()
		return array, err
	}
	return token, nil
}

func validateTransferProvider(provider map[string]any) error {
	if err := validateTransferFields(provider); err != nil {
		return err
	}
	models, ok := provider["models"].([]any)
	if !ok {
		return errors.New(apptext.T("供应商的 models 必须是数组。"))
	}
	seen := map[string]bool{}
	for _, value := range models {
		model, ok := value.(map[string]any)
		if !ok {
			return errors.New(apptext.T("每个模型必须是对象，且模型 ID 必须非空且唯一。"))
		}
		id, ok := model["id"].(string)
		if !ok || strings.TrimSpace(id) == "" || seen[id] {
			return errors.New(apptext.T("每个模型必须是对象，且模型 ID 必须非空且唯一。"))
		}
		seen[id] = true
		if err := validateTransferFields(model); err != nil {
			return err
		}
	}
	return nil
}

// Validate known fields without projecting through modelConfig, so future model
// metadata (including precise JSON numbers) survives import and export.
func validateTransferFields(object map[string]any) error {
	invalid := func() error { return errors.New(apptext.T("供应商或模型字段的类型或数字无效。")) }
	for _, key := range []string{"api", "baseUrl", "apiKey", "name"} {
		if value, exists := object[key]; exists {
			if _, ok := value.(string); !ok {
				return invalid()
			}
		}
	}
	for _, key := range []string{"reasoning", "authHeader"} {
		if value, exists := object[key]; exists {
			if _, ok := value.(bool); !ok {
				return invalid()
			}
		}
	}
	for _, key := range []string{"contextWindow", "maxTokens"} {
		if value, exists := object[key]; exists && !validTransferNumber(value, true) {
			return invalid()
		}
	}
	if value, exists := object["cost"]; exists {
		cost, ok := value.(map[string]any)
		if !ok {
			return invalid()
		}
		for _, key := range []string{"input", "output", "cacheRead", "cacheWrite"} {
			if value, exists := cost[key]; exists && !validTransferNumber(value, false) {
				return invalid()
			}
		}
	}
	if value, exists := object["input"]; exists {
		inputs, ok := value.([]any)
		if !ok {
			return invalid()
		}
		for _, value := range inputs {
			if _, ok := value.(string); !ok {
				return invalid()
			}
		}
	}
	for _, key := range []string{"headers", "compat"} {
		if value, exists := object[key]; exists {
			values, ok := value.(map[string]any)
			if !ok {
				return invalid()
			}
			if key == "compat" {
				for _, flag := range compatFlags {
					if value, exists := values[flag]; exists {
						if _, ok := value.(bool); !ok {
							return invalid()
						}
					}
				}
			}
			if key == "headers" {
				for name, value := range values {
					text, ok := value.(string)
					if !ok || strings.TrimSpace(name) == "" || strings.ContainsAny(name+text, "\r\n") {
						return invalid()
					}
				}
			}
		}
	}
	return nil
}

func validTransferNumber(value any, integer bool) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	n, err := number.Float64()
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return false
	}
	exact, ok := new(big.Rat).SetString(number.String())
	return ok && exact.Sign() >= 0 && (!integer || exact.IsInt())
}

func redactProviderTransfer(value any) {
	switch node := value.(type) {
	case map[string]any:
		for key, value := range node {
			name := strings.ToLower(strings.NewReplacer("-", "", "_", "", ".", "", " ", "").Replace(key))
			if strings.Contains(name, "secret") || strings.Contains(name, "pass"+"word") ||
				strings.HasSuffix(name, "apikey") || strings.HasSuffix(name, "authorization") ||
				strings.HasSuffix(name, "accesstoken") || strings.HasSuffix(name, "refreshtoken") ||
				strings.HasSuffix(name, "authtoken") || strings.HasSuffix(name, "sessiontoken") ||
				name == "token" || name == "bearertoken" || name == "privatekey" || name == "signingkey" ||
				name == "accesskey" || name == "sessionkey" || name == "authentication" ||
				name == "auth" || name == "credentials" || name == "cookie" || name == "setcookie" || name == "passwd" {
				delete(node, key)
				continue
			}
			if name == "headers" {
				if headers, ok := value.(map[string]any); ok {
					for header := range headers {
						lower := strings.ToLower(header)
						if strings.Contains(lower, "auth") || strings.Contains(lower, "key") || strings.Contains(lower, "token") || strings.Contains(lower, "cookie") || strings.Contains(lower, "secret") {
							delete(headers, header)
						}
					}
				}
			}
			redactProviderTransfer(value)
		}
	case []any:
		for _, value := range node {
			redactProviderTransfer(value)
		}
	}
}
