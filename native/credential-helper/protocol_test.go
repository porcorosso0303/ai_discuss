package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type memoryCredentialStore struct {
	entries map[string]memoryCredential
	err     error
}

type memoryCredential struct {
	origin string
	secret string
}

func (store *memoryCredentialStore) set(target, origin, secret string) error {
	if store.err != nil {
		return store.err
	}
	store.entries[target] = memoryCredential{origin: origin, secret: secret}
	return nil
}

func (store *memoryCredentialStore) get(target string) (string, string, bool, error) {
	if store.err != nil {
		return "", "", false, store.err
	}
	entry, found := store.entries[target]
	return entry.secret, entry.origin, found, nil
}

func (store *memoryCredentialStore) delete(target string) error {
	if store.err != nil {
		return store.err
	}
	delete(store.entries, target)
	return nil
}

func request(t *testing.T, store credentialStore, input string) response {
	t.Helper()
	var output bytes.Buffer
	runProtocol(strings.NewReader(input), &output, store)
	var result response
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("invalid protocol response %q: %v", output.String(), err)
	}
	return result
}

func TestProtocolSetGetDeleteAndOriginBinding(t *testing.T) {
	store := &memoryCredentialStore{entries: make(map[string]memoryCredential)}
	secret := "令牌-secret-value"

	set := request(t, store, `{"operation":"set","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn","secret":"`+secret+`"}`)
	if !set.OK || set.Found != nil || set.Secret != "" || set.ErrorCode != "" {
		t.Fatalf("unexpected set response: %#v", set)
	}

	get := request(t, store, `{"operation":"get","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn"}`)
	if !get.OK || get.Found == nil || !*get.Found || get.Secret != secret {
		t.Fatalf("unexpected get response: %#v", get)
	}

	wrongOrigin := request(t, store, `{"operation":"get","target":"AI Debates/role-a/kimi","origin":"https://example.com"}`)
	if !wrongOrigin.OK || wrongOrigin.Found == nil || *wrongOrigin.Found || wrongOrigin.Secret != "" {
		t.Fatalf("origin mismatch exposed a credential: %#v", wrongOrigin)
	}

	deleted := request(t, store, `{"operation":"delete","target":"AI Debates/role-a/kimi"}`)
	if !deleted.OK || deleted.Found != nil || deleted.Secret != "" {
		t.Fatalf("unexpected delete response: %#v", deleted)
	}

	missing := request(t, store, `{"operation":"get","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn"}`)
	if !missing.OK || missing.Found == nil || *missing.Found || missing.Secret != "" {
		t.Fatalf("unexpected missing response: %#v", missing)
	}
}

func TestProtocolRejectsInvalidTargetsAndMalformedRequests(t *testing.T) {
	store := &memoryCredentialStore{entries: make(map[string]memoryCredential)}
	cases := map[string]string{
		"unknown role":        `{"operation":"get","target":"AI Debates/role-c/kimi","origin":"https://api.moonshot.cn"}`,
		"openai provider":     `{"operation":"delete","target":"AI Debates/role-a/openai"}`,
		"target suffix":       `{"operation":"delete","target":"AI Debates/role-a/kimi/extra"}`,
		"unknown field":       `{"operation":"delete","target":"AI Debates/role-a/kimi","secret":"leak"}`,
		"trailing json":       `{"operation":"delete","target":"AI Debates/role-a/kimi"}{}`,
		"missing get origin":  `{"operation":"get","target":"AI Debates/role-a/kimi"}`,
		"set empty secret":    `{"operation":"set","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn","secret":""}`,
		"noncanonical origin": `{"operation":"get","target":"AI Debates/role-a/kimi","origin":"https://API.MOONSHOT.CN/"}`,
		"origin too long":     `{"operation":"get","target":"AI Debates/role-a/kimi","origin":"https://` + strings.Repeat("a", 505) + `.test"}`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			result := request(t, store, input)
			if result.OK || result.ErrorCode != "invalid_request" || result.Secret != "" {
				t.Fatalf("unexpected rejection response: %#v", result)
			}
		})
	}
}

func TestProtocolBoundsInputAndNeverEchoesSecretsInErrors(t *testing.T) {
	secret := strings.Repeat("x", maxCredentialBlobBytes+1)
	store := &memoryCredentialStore{entries: make(map[string]memoryCredential)}
	result := request(t, store, `{"operation":"set","target":"AI Debates/role-b/deepseek","origin":"https://api.deepseek.com","secret":"`+secret+`"}`)
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if result.OK || result.ErrorCode != "invalid_request" || bytes.Contains(encoded, []byte(secret)) {
		t.Fatalf("secret was accepted or echoed: %s", encoded)
	}

	store.err = errors.New("backend failure containing " + secret)
	result = request(t, store, `{"operation":"get","target":"AI Debates/role-b/deepseek","origin":"https://api.deepseek.com"}`)
	encoded, err = json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if result.OK || result.ErrorCode != "storage_error" || bytes.Contains(encoded, []byte(secret)) {
		t.Fatalf("backend error leaked data: %s", encoded)
	}
}

func TestProtocolRejectsSecretsThatCannotRoundTripThroughUTF16(t *testing.T) {
	store := &memoryCredentialStore{entries: make(map[string]memoryCredential)}
	prefix := `{"operation":"set","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn","secret":"`
	cases := map[string]string{
		"unpaired high surrogate": prefix + `\ud800"}`,
		"unpaired low surrogate":  prefix + `\udc00"}`,
		"invalid utf8":            prefix + string([]byte{0xff}) + `"}`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			result := request(t, store, input)
			if result.OK || result.ErrorCode != "invalid_request" || result.Secret != "" {
				t.Fatalf("unexpected rejection response: %#v", result)
			}
		})
	}
}

func TestProtocolAcceptsPairedSurrogatesUpToTheCredentialBlobLimit(t *testing.T) {
	store := &memoryCredentialStore{entries: make(map[string]memoryCredential)}
	secret := strings.Repeat("😀", maxCredentialBlobBytes/4)
	payload, err := json.Marshal(map[string]string{
		"operation": "set",
		"target":    "AI Debates/role-a/kimi",
		"origin":    "https://api.moonshot.cn",
		"secret":    secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	result := request(t, store, string(payload))
	if !result.OK || store.entries["AI Debates/role-a/kimi"].secret != secret {
		t.Fatalf("valid UTF-16 secret did not round trip: %#v", result)
	}
	escaped := request(t, store, `{"operation":"set","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn","secret":"\ud83d\ude00"}`)
	if !escaped.OK || store.entries["AI Debates/role-a/kimi"].secret != "😀" {
		t.Fatalf("escaped surrogate pair did not round trip: %#v", escaped)
	}
}

func TestProtocolReturnsUnsupportedWithoutWritingPlaintext(t *testing.T) {
	store := &memoryCredentialStore{entries: make(map[string]memoryCredential), err: errUnsupported}
	result := request(t, store, `{"operation":"set","target":"AI Debates/role-a/kimi","origin":"https://api.moonshot.cn","secret":"never-write-this"}`)
	if result.OK || result.ErrorCode != "unsupported" || result.Secret != "" {
		t.Fatalf("unexpected unsupported response: %#v", result)
	}
}
