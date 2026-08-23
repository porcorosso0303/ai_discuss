//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"os"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const (
	credTypeGeneric         = 1
	credPersistLocalMachine = 2
	errorNotFound           = syscall.Errno(1168)
)

var (
	advapi32           = syscall.NewLazyDLL("advapi32.dll")
	procCredWriteW     = advapi32.NewProc("CredWriteW")
	procCredReadW      = advapi32.NewProc("CredReadW")
	procCredDeleteW    = advapi32.NewProc("CredDeleteW")
	procCredFree       = advapi32.NewProc("CredFree")
	errCredentialStore = errors.New("credential manager operation failed")
)

type windowsCredentialStore struct{}

type credentialW struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        syscall.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

func (windowsCredentialStore) set(target, origin, secret string) error {
	targetPointer, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return errCredentialStore
	}
	originPointer, err := syscall.UTF16PtrFromString(origin)
	if err != nil {
		return errCredentialStore
	}
	secretUnits := utf16.Encode([]rune(secret))
	defer clear(secretUnits)
	if len(secretUnits)*2 > maxCredentialBlobBytes {
		return errCredentialStore
	}
	var blobPointer *byte
	if len(secretUnits) > 0 {
		blobPointer = (*byte)(unsafe.Pointer(&secretUnits[0]))
	}
	credential := credentialW{
		Type:               credTypeGeneric,
		TargetName:         targetPointer,
		CredentialBlobSize: uint32(len(secretUnits) * 2),
		CredentialBlob:     blobPointer,
		Persist:            credPersistLocalMachine,
		UserName:           originPointer,
	}
	result, _, _ := procCredWriteW.Call(uintptr(unsafe.Pointer(&credential)), 0)
	runtime.KeepAlive(secretUnits)
	runtime.KeepAlive(targetPointer)
	runtime.KeepAlive(originPointer)
	if result == 0 {
		return errCredentialStore
	}
	return nil
}

func (windowsCredentialStore) get(target string) (secret, origin string, found bool, returnedError error) {
	targetPointer, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return "", "", false, errCredentialStore
	}
	var credential *credentialW
	result, _, callError := procCredReadW.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		credTypeGeneric,
		0,
		uintptr(unsafe.Pointer(&credential)),
	)
	runtime.KeepAlive(targetPointer)
	if result == 0 {
		if errors.Is(callError, errorNotFound) {
			return "", "", false, nil
		}
		return "", "", false, errCredentialStore
	}
	if credential == nil {
		return "", "", false, errCredentialStore
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(credential)))

	if credential.CredentialBlobSize == 0 ||
		credential.CredentialBlobSize > maxCredentialBlobBytes ||
		credential.CredentialBlobSize%2 != 0 || credential.CredentialBlob == nil {
		return "", "", false, errCredentialStore
	}
	blob := unsafe.Slice(credential.CredentialBlob, int(credential.CredentialBlobSize))
	defer clear(blob)
	secretUnits := make([]uint16, len(blob)/2)
	defer clear(secretUnits)
	for index := range secretUnits {
		secretUnits[index] = binary.LittleEndian.Uint16(blob[index*2 : index*2+2])
	}
	storedOrigin, ok := readUTF16Pointer(credential.UserName, maxOriginUTF16Units)
	if !ok {
		return "", "", false, errCredentialStore
	}
	decodedSecret, ok := decodeUTF16(secretUnits)
	if !ok {
		return "", "", false, errCredentialStore
	}
	return decodedSecret, storedOrigin, true, nil
}

func (windowsCredentialStore) delete(target string) error {
	targetPointer, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return errCredentialStore
	}
	result, _, callError := procCredDeleteW.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		credTypeGeneric,
		0,
	)
	runtime.KeepAlive(targetPointer)
	if result == 0 && !errors.Is(callError, errorNotFound) {
		return errCredentialStore
	}
	return nil
}

func readUTF16Pointer(pointer *uint16, maximum int) (string, bool) {
	if pointer == nil {
		return "", false
	}
	units := unsafe.Slice(pointer, maximum+1)
	for index, unit := range units {
		if unit == 0 {
			return string(utf16.Decode(units[:index])), true
		}
	}
	return "", false
}

func main() {
	runProtocol(os.Stdin, os.Stdout, windowsCredentialStore{})
}
