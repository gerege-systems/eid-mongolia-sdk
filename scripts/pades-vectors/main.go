//go:build ignore

// TS SDK-ийн WASM golden vector-ийг НАТИВ Go core-оор гаргана: test/pades-wasm.test.ts WASM-ын гаралтыг үүнтэй
// байт-байтаар тулгана (нэг хэрэгжүүлэлт — D5). scripts/build-pades-wasm.sh --vectors ажиллуулна (Go SDK-ийн clone дотор).
//
//	go run main.go <fixtures dir> > vectors.json
package main

import (
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gerege-systems/eid-mongolia-sdk-go/pades"
)

type prepCase struct {
	Name    string         `json:"name"`
	Input   string         `json:"input"`
	Options map[string]any `json:"options"` // JS талын prepare() options (Date нь ISO мөр)
	DTBS    string         `json:"dtbs,omitempty"`
	Digest  string         `json:"digest,omitempty"`
	DocID   string         `json:"docId,omitempty"`
	Error   string         `json:"error,omitempty"`
}

type verifyCase struct {
	Name   string          `json:"name"`
	Input  string          `json:"input"`
	Time   string          `json:"time"`
	Report json.RawMessage `json:"report"`
}

func der(dir, name string) []byte {
	b, err := os.ReadFile(filepath.Join(dir, name))
	must(err)
	p, _ := pem.Decode(b)
	return p.Bytes
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func main() {
	dir := os.Args[1]
	leaf, root := der(dir, "leaf.pem"), der(dir, "root.pem")
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.FixedZone("+08", 8*3600))
	cases := []struct {
		c prepCase
		o pades.PrepareOptions
	}{
		{prepCase{Name: "quartz-page-onbehalf", Input: "base-quartz.pdf", Options: map[string]any{
			"signerName": "Бат Болд", "reason": "Гэрэгэ Системс ХХК-ийг төлөөлж",
			"claimedRole": "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)", "signingTime": at.Format(time.RFC3339),
			"docId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "verifyPage": true, "fileName": "Гэрээ №12.pdf", "lang": "mn"}},
			pades.PrepareOptions{SignerCert: leaf, Chain: [][]byte{root}, SignerName: "Бат Болд", Reason: "Гэрэгэ Системс ХХК-ийг төлөөлж",
				ClaimedRole: "Гүйцэтгэх захирал, Гэрэгэ Системс ХХК (NTRMN-6235972)", SigningTime: at,
				DocID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", VerifyPage: true, FileName: "Гэрээ №12.pdf", Lang: "mn"}},
		{prepCase{Name: "objstm-nopage", Input: "base-objstm.pdf", Options: map[string]any{
			"signingTime": at.Format(time.RFC3339), "docId": "3f2504e0-4f89-41d3-9a0c-0305e82c3302"}},
			pades.PrepareOptions{SignerCert: leaf, Chain: [][]byte{root}, SigningTime: at, DocID: "3f2504e0-4f89-41d3-9a0c-0305e82c3302"}},
		{prepCase{Name: "not-pdf", Input: "leaf.pem", Options: map[string]any{}}, pades.PrepareOptions{SignerCert: leaf, Chain: [][]byte{root}}},
		{prepCase{Name: "bad-docid", Input: "base-quartz.pdf", Options: map[string]any{"docId": "NOT-A-UUID"}},
			pades.PrepareOptions{SignerCert: leaf, Chain: [][]byte{root}, DocID: "NOT-A-UUID"}},
	}
	var out struct {
		Generator string       `json:"generator"`
		Prepare   []prepCase   `json:"prepare"`
		Verify    []verifyCase `json:"verify"`
	}
	out.Generator = "scripts/pades-vectors/main.go (" + pades.ProfileVersion + ")"
	for _, tc := range cases {
		in, err := os.ReadFile(filepath.Join(dir, tc.c.Input))
		must(err)
		p, err := pades.Prepare(in, tc.o)
		if err != nil {
			tc.c.Error = pades.ErrorCode(err)
		} else {
			tc.c.DTBS, tc.c.Digest, tc.c.DocID = hex.EncodeToString(p.DTBS), hex.EncodeToString(p.Digest), p.DocID
		}
		out.Prepare = append(out.Prepare, tc.c)
	}
	vt := time.Date(2026, 10, 15, 0, 0, 0, 0, time.UTC)
	in, err := os.ReadFile(filepath.Join(dir, "quartz-1-dss.pdf"))
	must(err)
	rep, err := pades.Verify(in, pades.VerifyOptions{Roots: [][]byte{root}, Issuers: [][]byte{root}, Time: vt})
	must(err)
	rb, err := json.Marshal(rep)
	must(err)
	out.Verify = append(out.Verify, verifyCase{Name: "desktop-quartz-1-dss", Input: "quartz-1-dss.pdf", Time: vt.Format(time.RFC3339), Report: rb})
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	must(enc.Encode(out))
}
