// Package certs persists the platform-issued link TLS material (PEM) into
// the agent's certs directory. The generated GOST config references these
// files by path; writing them here (not inside the builder) keeps the builder
// a pure function of the payload. Mount the working directory like
// last-config.json / quota-store.json to survive container restarts.
package certs

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/laoshan-tech/tyz/apps/agent/internal/model"
)

// File names inside the certs directory. Stable names keep the generated
// GOST config byte-identical across restarts, so the registry diff-apply
// never sees phantom changes.
const (
	DirName    = "certs"
	CACertFile = "ca-cert.pem"
	ServerCert = "tls-cert.pem"
	ServerKey  = "tls-key.pem"
	ClientCert = "client-cert.pem"
	ClientKey  = "client-key.pem"

	dirPerm  os.FileMode = 0o700
	filePerm os.FileMode = 0o600
)

// Path returns the certs directory under base (working directory).
func Path(base string) string {
	return filepath.Join(base, DirName)
}

// Ensure writes the PEM files for material into base/certs, creating the
// directory as needed. Files whose content is unchanged are left alone — a
// rewrite would only churn mtimes (the config references paths, not hashes,
// but the agent's own diff/debug output benefits from stability).
func Ensure(base string, material *model.TLSMaterial) error {
	if material == nil {
		return nil
	}
	if err := os.MkdirAll(Path(base), dirPerm); err != nil {
		return fmt.Errorf("create certs dir: %w", err)
	}
	files := map[string]string{
		CACertFile: material.CACert,
		ServerCert: material.ServerCert,
		ServerKey:  material.ServerKey,
		ClientCert: material.ClientCert,
		ClientKey:  material.ClientKey,
	}
	for name, pem := range files {
		if pem == "" {
			return fmt.Errorf("tls material: %s is empty", name)
		}
		target := filepath.Join(Path(base), name)
		if current, err := os.ReadFile(target); err == nil && string(current) == pem {
			continue
		}
		if err := writeAtomic(target, []byte(pem)); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
	}
	return nil
}

// writeAtomic mirrors loop/cache.go: temp file + fsync + rename, so power
// loss can never leave a truncated certificate on disk.
func writeAtomic(target string, data []byte) error {
	tmp := target + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, filePerm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}
