package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	maxProtocolRequestBytes = 32 * 1024
	maxCredentialBlobBytes  = 2560
	maxOriginUTF16Units     = 513
)

var errUnsupported = errors.New("credential storage is unsupported")

type credentialStore interface {
	set(target, origin, secret string) error
	get(target string) (secret, origin string, found bool, err error)
	delete(target string) error
}

type protocolRequest struct {
	Operation string
	Target    string
	Origin    string
	Secret    string
}

type response struct {
	OK        bool   `json:"ok"`
	Found     *bool  `json:"found,omitempty"`
	Secret    string `json:"secret,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

var validTargets = map[string]struct{}{
	"AI Debates/role-a/kimi":     {},
	"AI Debates/role-a/deepseek": {},
	"AI Debates/role-b/kimi":     {},
	"AI Debates/role-b/deepseek": {},
}

func runProtocol(reader io.Reader, writer io.Writer, store credentialStore) {
	request, err := decodeRequest(reader)
	result := response{}
	if err != nil {
		result.ErrorCode = "invalid_request"
	} else {
		result = handleRequest(store, request)
	}
	_ = json.NewEncoder(writer).Encode(result)
}

func decodeRequest(reader io.Reader) (protocolRequest, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxProtocolRequestBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxProtocolRequestBytes ||
		!validJSONStringUnicode(data) {
		return protocolRequest{}, errors.New("invalid request")
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return protocolRequest{}, errors.New("invalid request")
	}
	fields := make(map[string]string)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok {
			return protocolRequest{}, errors.New("invalid request")
		}
		if _, duplicate := fields[key]; duplicate {
			return protocolRequest{}, errors.New("invalid request")
		}
		var value string
		if err := decoder.Decode(&value); err != nil {
			return protocolRequest{}, errors.New("invalid request")
		}
		fields[key] = value
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return protocolRequest{}, errors.New("invalid request")
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return protocolRequest{}, errors.New("invalid request")
	}

	operation, operationPresent := fields["operation"]
	target, targetPresent := fields["target"]
	if !operationPresent || !targetPresent {
		return protocolRequest{}, errors.New("invalid request")
	}
	if _, ok := validTargets[target]; !ok {
		return protocolRequest{}, errors.New("invalid request")
	}

	request := protocolRequest{Operation: operation, Target: target}
	switch operation {
	case "get":
		if len(fields) != 3 {
			return protocolRequest{}, errors.New("invalid request")
		}
		origin, present := fields["origin"]
		if !present || !isCanonicalOrigin(origin) {
			return protocolRequest{}, errors.New("invalid request")
		}
		request.Origin = origin
	case "set":
		if len(fields) != 4 {
			return protocolRequest{}, errors.New("invalid request")
		}
		origin, originPresent := fields["origin"]
		secret, secretPresent := fields["secret"]
		if !originPresent || !isCanonicalOrigin(origin) || !secretPresent || !validSecret(secret) {
			return protocolRequest{}, errors.New("invalid request")
		}
		request.Origin = origin
		request.Secret = secret
	case "delete":
		if len(fields) != 2 {
			return protocolRequest{}, errors.New("invalid request")
		}
	default:
		return protocolRequest{}, errors.New("invalid request")
	}
	return request, nil
}

func validJSONStringUnicode(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	inString := false
	for index := 0; index < len(data); index++ {
		switch data[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(data) {
				continue
			}
			if data[index+1] != 'u' {
				index++
				continue
			}
			unit, ok := parseJSONUTF16Unit(data, index+2)
			if !ok || unit >= 0xdc00 && unit <= 0xdfff {
				return false
			}
			if unit >= 0xd800 && unit <= 0xdbff {
				if index+7 >= len(data) || data[index+6] != '\\' || data[index+7] != 'u' {
					return false
				}
				low, lowOK := parseJSONUTF16Unit(data, index+8)
				if !lowOK || low < 0xdc00 || low > 0xdfff {
					return false
				}
				index += 11
				continue
			}
			index += 5
		}
	}
	return true
}

func parseJSONUTF16Unit(data []byte, start int) (uint16, bool) {
	if start+4 > len(data) {
		return 0, false
	}
	var unit uint16
	for _, character := range data[start : start+4] {
		unit <<= 4
		switch {
		case character >= '0' && character <= '9':
			unit |= uint16(character - '0')
		case character >= 'a' && character <= 'f':
			unit |= uint16(character-'a') + 10
		case character >= 'A' && character <= 'F':
			unit |= uint16(character-'A') + 10
		default:
			return 0, false
		}
	}
	return unit, true
}

func isCanonicalOrigin(value string) bool {
	if value == "" || len(utf16.Encode([]rune(value))) > maxOriginUTF16Units ||
		strings.ContainsRune(value, '\x00') {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.User != nil || parsed.Host == "" ||
		parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		parsed.Fragment != "" {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" || hostname != parsed.Hostname() {
		return false
	}
	port := parsed.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		return false
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	}
	if value != scheme+"://"+host {
		return false
	}
	if scheme == "http" {
		return hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
	}
	return true
}

func validSecret(secret string) bool {
	if secret == "" {
		return false
	}
	return len(utf16.Encode([]rune(secret)))*2 <= maxCredentialBlobBytes
}

func handleRequest(store credentialStore, request protocolRequest) response {
	switch request.Operation {
	case "set":
		if err := store.set(request.Target, request.Origin, request.Secret); err != nil {
			return storageError(err)
		}
		return response{OK: true}
	case "get":
		secret, origin, found, err := store.get(request.Target)
		if err != nil {
			return storageError(err)
		}
		matches := found && origin == request.Origin
		return response{OK: true, Found: boolPointer(matches), Secret: secretIf(matches, secret)}
	case "delete":
		if err := store.delete(request.Target); err != nil {
			return storageError(err)
		}
		return response{OK: true}
	default:
		return response{ErrorCode: "invalid_request"}
	}
}

func storageError(err error) response {
	if errors.Is(err, errUnsupported) {
		return response{ErrorCode: "unsupported"}
	}
	return response{ErrorCode: "storage_error"}
}

func boolPointer(value bool) *bool { return &value }

func secretIf(condition bool, secret string) string {
	if condition {
		return secret
	}
	return ""
}
