package pades

// TEMPORARY (PR #87): records test/fixtures/pades/seal (eid-mongolia-sdk) with the Go reference pades.SealPDF —
// fixed seal certificate + ECDSA signature from the TS fixture, replayed TSA/OCSP/CRL responses, seeded TSA nonce.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	eid "github.com/gerege-systems/eid-mongolia-sdk-go"
)

type tmpRecRT struct {
	dir  string
	http map[string]string
	used []string
}

func (r *tmpRecRT) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
	}
	sum := sha256.Sum256(body)
	key := req.Method + " " + req.URL.String() + " " + hex.EncodeToString(sum[:])[:16]
	f, ok := r.http[key]
	if !ok {
		r.used = append(r.used, "MISS "+key)
		return &http.Response{StatusCode: 404, Body: io.NopCloser(bytes.NewReader(nil)), Header: http.Header{}, Request: req}, nil
	}
	r.used = append(r.used, key+" -> "+f)
	b, err := os.ReadFile(filepath.Join(r.dir, f))
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b)), Header: http.Header{}, ContentLength: int64(len(b)), Request: req}, nil
}

type tmpRecSealer struct{ cert, sig []byte }

func (s *tmpRecSealer) Certificate(context.Context, string) (*eid.SealCertificate, error) {
	return &eid.SealCertificate{OrgEtsi: "NTRMN-6235972", Certificate: s.cert, CertificateLevel: eid.LevelQualified}, nil
}

func (s *tmpRecSealer) Seal(_ context.Context, org string, _ []byte, _ eid.HashAlgorithm) (*eid.SealResult, error) {
	return &eid.SealResult{OrgEtsi: org, Signature: s.sig, Certificate: s.cert}, nil
}

func tmpRecPEM(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		t.Fatalf("%s: no PEM", p)
	}
	return blk.Bytes
}

func TestTmpSealRecord(t *testing.T) {
	sd, gd := os.Getenv("SEAL_DIR"), os.Getenv("GOLDEN_DIR")
	if sd == "" || gd == "" {
		t.Skip("SEAL_DIR/GOLDEN_DIR")
	}
	var m struct {
		Reason    string            `json:"reason"`
		Signature string            `json:"signature"`
		HTTP      map[string]string `json:"http"`
	}
	raw, err := os.ReadFile(filepath.Join(sd, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	sig, err := base64.StdEncoding.DecodeString(m.Signature)
	if err != nil {
		t.Fatal(err)
	}
	pki := func(n string) []byte { return tmpRecPEM(t, filepath.Join(gd, "pki", n+".pem")) }
	input, err := os.ReadFile(filepath.Join(gd, "input", "quartz-pdf13.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	nonceReader = &seededReader{seed: []byte("golden-nonce:seal")}
	defer func() { nonceReader = rand.Reader }()
	origSleep := sleepFn
	sleepFn = func(context.Context, time.Duration) error { return nil }
	defer func() { sleepFn = origSleep }()
	rt := &tmpRecRT{dir: sd, http: m.HTTP}
	zero := 0
	res, err := SealPDF(context.Background(), &tmpRecSealer{cert: tmpRecPEM(t, filepath.Join(sd, "seal.pem")), sig: sig}, "NTRMN-6235972", input, SealOptions{
		Reason:      m.Reason,
		SigningTime: goldenTime,
		Chain:       [][]byte{pki("04"), pki("03"), pki("02")},
		Complete: CompleteOptions{
			HTTPClient: &http.Client{Transport: rt},
			TSAURL:     "http://tsa.pki.test/",
			Now:        func() time.Time { return goldenNow },
			Roots:      [][]byte{pki("root")},
			LTVRetries: &zero,
		},
	})
	for _, u := range rt.used {
		fmt.Println("RECORD http", u)
	}
	if err != nil {
		t.Fatal(err)
	}
	cs := sha256.Sum256(res.CMS)
	fmt.Println("RECORD outSha256", res.OutSHA256)
	fmt.Println("RECORD cmsSha256", hex.EncodeToString(cs[:]))
}
