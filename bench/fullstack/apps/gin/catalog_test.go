package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func sampleCatalogRecord() *catalogRecord {
	return &catalogRecord{
		ID: "record_1", Title: `<img src=x onerror="bad()">`, Subtitle: "Notes", Description: "<&>",
		Tags: []string{}, Fields: []catalogField{{"Access", "North"}, {"access", "South"}, {" Access", "West"}},
		Related: []catalogRelated{},
	}
}

func TestCatalogFixtureWarmsAtStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.json")
	body, err := json.Marshal(map[string]*catalogRecord{"record_1": sampleCatalogRecord()})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CATALOG_SOURCE", "fixture")
	t.Setenv("CATALOG_FIXTURE_PATH", path)
	source, err := newCatalogSource()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		record, err := source.get(context.Background(), "record_1")
		if err != nil || record == nil || record.Title != sampleCatalogRecord().Title {
			t.Fatalf("record=%v error=%v", record, err)
		}
	}
	if record, err := source.get(context.Background(), "unknown"); record != nil || err != nil {
		t.Fatalf("record=%v error=%v", record, err)
	}
}

func TestCatalogFetchesOncePerRequest(t *testing.T) {
	calls := 0
	status := http.StatusOK
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/catalog/records/record_1" {
			t.Errorf("path=%s", r.URL.Path)
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(sampleCatalogRecord())
	}))
	defer upstream.Close()
	t.Setenv("CATALOG_SOURCE", "api")
	t.Setenv("API_BASE", upstream.URL)
	source, err := newCatalogSource()
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if record, err := source.get(context.Background(), "record_1"); record == nil || err != nil {
			t.Fatalf("record=%v error=%v", record, err)
		}
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
	status = http.StatusNotFound
	if record, err := source.get(context.Background(), "record_1"); record != nil || err != nil {
		t.Fatalf("record=%v error=%v", record, err)
	}
	status = http.StatusServiceUnavailable
	if _, err := source.get(context.Background(), "record_1"); err == nil {
		t.Fatal("upstream failure accepted")
	}
	if calls != 4 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestCatalogRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	record := sampleCatalogRecord()
	source := &catalogSource{fixture: map[string]*catalogRecord{"record_1": record}}
	source.routes(router)
	for _, tc := range []struct{ prefix, wanted string }{{"Ac", "Access"}, {"ac", "access"}, {"+Ac", " Access"}, {"Ac+", ""}, {"%3C%26%22", ""}} {
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/catalog/record_1?field="+tc.prefix, nil))
		body := res.Body.String()
		if res.Code != 200 {
			t.Fatalf("status=%d body=%s", res.Code, body)
		}
		if strings.Contains(body, "<img") || !strings.Contains(body, "&lt;img") {
			t.Fatal("record title not escaped")
		}
		if !strings.Contains(body, `href="/catalog.css"`) {
			t.Fatal("missing stylesheet")
		}
		for _, field := range record.Fields {
			if strings.Contains(body, `scope="row">`+field.Name+"</th>") != (field.Name == tc.wanted) {
				t.Fatalf("prefix=%s field=%s", tc.prefix, field.Name)
			}
		}
	}
	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/catalog/record_1?field=Ac", nil))
	var got catalogRecord
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Fields) != 3 || got.Tags == nil || got.Related == nil {
		t.Fatalf("wrong JSON: %s", res.Body.String())
	}
	for _, path := range []string{"/catalog/unknown", "/api/catalog/unknown"} {
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		if res.Code != 404 {
			t.Fatalf("%s: status=%d", path, res.Code)
		}
	}
}
