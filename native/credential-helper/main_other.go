//go:build !windows

package main

import "os"

type unsupportedCredentialStore struct{}

func (unsupportedCredentialStore) set(string, string, string) error {
	return errUnsupported
}

func (unsupportedCredentialStore) get(string) (string, string, bool, error) {
	return "", "", false, errUnsupported
}

func (unsupportedCredentialStore) delete(string) error {
	return errUnsupported
}

func main() {
	runProtocol(os.Stdin, os.Stdout, unsupportedCredentialStore{})
}
