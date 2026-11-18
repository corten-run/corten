package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCatalogLeanLoggingAndRecovery(t *testing.T) {
	mode := gin.Mode()
	output, errors := gin.DefaultWriter, gin.DefaultErrorWriter
	gin.SetMode(gin.ReleaseMode)
	t.Cleanup(func() {
		gin.SetMode(mode)
		gin.DefaultWriter, gin.DefaultErrorWriter = output, errors
	})
	for _, profile := range []string{"", "defaults", "matched", "catalog-lean", "catalog-lean-extra", " catalog-lean", "CATALOG-LEAN"} {
		t.Run("profile="+profile, func(t *testing.T) {
			t.Setenv("PROFILE", profile)
			var access, recovery bytes.Buffer
			gin.DefaultWriter, gin.DefaultErrorWriter = &access, &recovery
			r := newRouter()
			r.GET("/ok", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
			r.GET("/panic", func(c *gin.Context) { panic("catalog profile panic") })
			for _, path := range []string{"/ok", "/panic", "/ok"} {
				access.Reset()
				res := httptest.NewRecorder()
				r.ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
				want := http.StatusOK
				if path == "/panic" {
					want = http.StatusInternalServerError
				}
				if res.Code != want {
					t.Fatalf("%s: status=%d, want %d", path, res.Code, want)
				}
				if profile == "catalog-lean" {
					if access.Len() != 0 {
						t.Fatalf("lean access log: %s", access.String())
					}
				} else if !strings.Contains(access.String(), path) {
					t.Fatalf("missing ordinary access log for %s: %s", path, access.String())
				}
			}
			if !strings.Contains(recovery.String(), "catalog profile panic") {
				t.Fatalf("panic recovery log missing: %s", recovery.String())
			}
		})
	}
}

func TestCatalogLeanDocumentHeaders(t *testing.T) {
	source := &catalogSource{fixture: map[string]*catalogRecord{"record_1": sampleCatalogRecord()}}
	baseline := map[string]string{
		"Content-Security-Policy":    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
		"X-Content-Type-Options":     "nosniff",
		"Referrer-Policy":            "strict-origin-when-cross-origin",
		"X-Frame-Options":            "DENY",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Permissions-Policy":         "camera=(), microphone=(), geolocation=()",
	}
	for _, profile := range []string{"catalog-lean", "catalog-lean-extra"} {
		t.Run(profile, func(t *testing.T) {
			t.Setenv("PROFILE", profile)
			router := newRouter()
			source.routes(router)
			router.StaticFile("/catalog.css", "static/catalog.css")
			for _, tc := range []struct {
				path   string
				status int
				cache  string
			}{
				{"/catalog/record_1?field=Ac", http.StatusOK, ""},
				{"/catalog/missing", http.StatusNotFound, ""},
				{"/api/catalog/record_1", http.StatusOK, "no-store"},
				{"/catalog.css", http.StatusOK, ""},
			} {
				res := httptest.NewRecorder()
				router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, tc.path, nil))
				if res.Code != tc.status {
					t.Fatalf("%s: status=%d, want %d", tc.path, res.Code, tc.status)
				}
				document := profile == "catalog-lean" && tc.path == "/catalog/record_1?field=Ac"
				for name, value := range baseline {
					want := ""
					if document {
						want = value
					}
					if got := res.Header().Get(name); got != want {
						t.Errorf("%s: %s=%q, want %q", tc.path, name, got, want)
					}
				}
				if document {
					tc.cache = "private, no-cache"
				}
				if got := res.Header().Get("Cache-Control"); got != tc.cache {
					t.Errorf("%s: Cache-Control=%q, want %q", tc.path, got, tc.cache)
				}
			}
		})
	}
}
