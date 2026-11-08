package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
)

func mpInt(n int64) *int64 { return &n }
func sampleMarketplace() *marketplaceRecord {
	sub := ""
	return &marketplaceRecord{ID: "item_1", Title: `Ember <script>bad()</script> & "dragon"`, Subtitle: &sub, Description: "<&>",
		Categories: []marketplaceCategory{{"Cards", "cards"}}, Badges: []string{}, Tags: []string{}, Images: []string{"/dragon.webp"}, Fields: []marketplaceField{},
		Summary: &marketplaceSummary{mpInt(-123450), 1000000, 1234},
		Listings: []marketplaceListing{
			{ID: "equal_first", Seller: "Alice", RatingHundredths: mpInt(425), Reviews: 1234, Quantity: 1000, PriceMinor: mpInt(125)},
			{ID: "missing", Seller: "alice", PriceMinor: nil}, {ID: "negative", Seller: " Alice", PriceMinor: mpInt(-125)},
			{ID: "equal_second", Seller: "Alice 2", PriceMinor: mpInt(125)}, {ID: "zero", Seller: "Alice 3", PriceMinor: mpInt(0)},
		},
		Offers:   []marketplaceOffer{{ID: "o1"}, {ID: "o2"}, {ID: "o3"}, {ID: "o4"}, {ID: "o5"}, {ID: "o6"}},
		Contents: []marketplaceLine{{ID: "line", ItemID: "item_2", Title: "Other", Quantity: 1234}}, IncludedIn: []marketplaceLine{}}
}
func mpSpaces(s string) string { return strings.NewReplacer("\u00a0", " ", "\u202f", " ").Replace(s) }
func TestMarketplaceFormatting(t *testing.T) {
	for locale, prices := range map[string][]string{
		"en-US": {"$0.00", "$0.01", "$0.10", "$1.25", "$1,234.50", "$1,234,567.89", "-$1,234.50"},
		"fr-FR": {"0,00 $US", "0,01 $US", "0,10 $US", "1,25 $US", "1 234,50 $US", "1 234 567,89 $US", "-1 234,50 $US"},
		"de-DE": {"0,00 $", "0,01 $", "0,10 $", "1,25 $", "1.234,50 $", "1.234.567,89 $", "-1.234,50 $"},
	} {
		f := newMarketplaceFormat(locale)
		for i, n := range []int64{0, 1, 10, 125, 123450, 123456789, -123450} {
			if got := mpSpaces(f.Money(&n)); got != prices[i] {
				t.Errorf("%s %d: %q != %q", locale, n, got, prices[i])
			}
		}
		if f.Money(nil) != "—" {
			t.Fatal("missing price")
		}
		for i, n := range []int64{0, 400, 425, 475, 499} {
			want := []string{"0", "4", "4.3", "4.8", "5"}[i]
			if locale != "en-US" {
				want = strings.ReplaceAll(want, ".", ",")
			}
			if got := f.Rating(n); got != want {
				t.Errorf("%s rating %d: %q", locale, n, got)
			}
		}
		for i, n := range []int64{0, 1, 2, 1000, 1000000} {
			words := []string{"listings", "listing", "listings", "listings", "listings"}
			if locale == "fr-FR" {
				words = []string{"annonce", "annonce", "annonces", "annonces", "d’annonces"}
			}
			if locale == "de-DE" {
				words = []string{"Angebote", "Angebot", "Angebote", "Angebote", "Angebote"}
			}
			if got := f.Listings(n); got != f.Count(n)+" "+words[i] {
				t.Errorf("%s plural %d: %q", locale, n, got)
			}
		}
		price := "1234.50"
		if locale != "en-US" {
			price = "1234,50"
		}
		success := f.Alert("{email} $&", "person@example.test", price)
		if !strings.Contains(success, "{email} $&") || !strings.Contains(success, f.Money(mpInt(123450))) {
			t.Fatal(success)
		}
		if f.Alert("T", "bad", price) != marketplaceLabels[locale]["invalid_email"] {
			t.Fatal("email")
		}
		for _, bad := range []string{"", "0", "-1", "NaN", "Infinity", "1e2", "1,2,3"} {
			if f.Alert("T", "x@y", bad) != marketplaceLabels[locale]["invalid_price"] {
				t.Fatal(bad)
			}
		}
	}
}
func TestMarketplaceSortAndLinks(t *testing.T) {
	record := sampleMarketplace()
	for _, tc := range []struct {
		query string
		ids   []string
	}{
		{"", []string{"negative", "zero", "equal_first", "equal_second", "missing"}},
		{"sort=desc", []string{"equal_first", "equal_second", "zero", "negative", "missing"}},
		{"seller=alice", []string{"missing"}}, {"seller=+Alice", []string{"negative"}}, {"seller=ALICE", nil},
	} {
		q, _ := url.ParseQuery(tc.query)
		v := newMarketplaceView(record, "fr-FR", q)
		var ids []string
		for _, r := range v.Listings {
			ids = append(ids, r.ID)
		}
		if !reflect.DeepEqual(ids, tc.ids) {
			t.Fatalf("%s: %v", tc.query, ids)
		}
	}
	q, _ := url.ParseQuery("seller=Alice+%26&sort=desc")
	v := newMarketplaceView(record, "fr-FR", q)
	more, _ := url.Parse(v.More)
	if len(v.Offers) != 5 || more.Query().Get("seller") != "Alice &" || more.Query().Get("sort") != "desc" || more.Query().Get("offers") != "all" {
		t.Fatal(v)
	}
	v = newMarketplaceView(record, "de-DE", url.Values{"offers": {"all"}})
	if len(v.Offers) != 6 || v.More != "" {
		t.Fatal(v)
	}
	if marketplaceURL("de-DE", "item/2") != "/marketplace/de-DE/item%2F2" {
		t.Fatal("URL encoding")
	}
}
func TestMarketplaceFixtureStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.json")
	body, _ := json.Marshal(map[string]*marketplaceRecord{"item_1": sampleMarketplace()})
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MARKETPLACE_SOURCE", "fixture")
	t.Setenv("MARKETPLACE_FIXTURE_PATH", path)
	source, err := newMarketplaceSource()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		r, err := source.get(context.Background(), "item_1")
		if err != nil || !reflect.DeepEqual(r, sampleMarketplace()) {
			t.Fatalf("%v %v", r, err)
		}
	}
	if r, err := source.get(context.Background(), "unknown"); r != nil || err != nil {
		t.Fatal(r, err)
	}
}
func TestMarketplaceRejectsUpstreamRedirect(t *testing.T) {
	var calls, redirected atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/redirect-target" {
			redirected.Add(1)
			_ = json.NewEncoder(w).Encode(sampleMarketplace())
			return
		}
		w.Header().Set("Location", "/redirect-target")
		w.WriteHeader(http.StatusFound)
	}))
	defer upstream.Close()
	t.Setenv("MARKETPLACE_SOURCE", "api")
	t.Setenv("API_BASE", upstream.URL)
	source, err := newMarketplaceSource()
	if err != nil {
		t.Fatal(err)
	}
	if record, err := source.get(context.Background(), "item_1"); err == nil || record != nil {
		t.Fatalf("302 must be an upstream error: record=%v err=%v", record, err)
	}
	if calls.Load() != 1 || redirected.Load() != 0 {
		t.Fatalf("302 followed: requests=%d redirected=%d", calls.Load(), redirected.Load())
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	source.routes(router)
	for _, path := range []string{"/marketplace/en-US/item_1", "/api/marketplace/item_1"} {
		before := calls.Load()
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		if res.Code != http.StatusBadGateway || calls.Load() != before+1 || redirected.Load() != 0 {
			t.Fatalf("%s: status=%d requests=%d redirected=%d", path, res.Code, calls.Load()-before, redirected.Load())
		}
	}
}

func TestMarketplaceRoutesAndHTTPSource(t *testing.T) {
	gin.SetMode(gin.TestMode)
	calls, status := 0, 200
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.EscapedPath() != "/marketplace/records/item_1" && r.URL.EscapedPath() != "/marketplace/records/item%2F1" {
			t.Error(r.URL)
		}
		w.WriteHeader(status)
		record := sampleMarketplace()
		record.Title += strings.Repeat("!", calls)
		_ = json.NewEncoder(w).Encode(record)
	}))
	defer upstream.Close()
	t.Setenv("MARKETPLACE_SOURCE", "api")
	t.Setenv("API_BASE", upstream.URL)
	source, err := newMarketplaceSource()
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	source.routes(router)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		before := calls
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "http://example.com")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != 400 && calls != before+1 {
			t.Fatalf("request fetched %d times", calls-before)
		}
		return res
	}
	for _, locale := range []string{"en-US", "fr-FR", "de-DE"} {
		res := request("GET", "/marketplace/"+locale+"/item_1", "")
		body := res.Body.String()
		if res.Code != 200 || !strings.Contains(body, `lang="`+locale+`"`) || !strings.Contains(body, `class="marketplace"`) || !strings.Contains(body, "&lt;script") || strings.Contains(body, "<script>bad") {
			t.Fatal(res.Code, body)
		}
		if strings.Count(body, "data-offer-id=") != 5 || strings.Count(body, "data-listing-id=") != 5 {
			t.Fatal("rows")
		}
		for _, name := range []string{"summary", "listings", "offers", "alert", "details", "contents", "included"} {
			if !strings.Contains(body, `class="marketplace__`+name+`"`) {
				t.Fatal(name)
			}
		}
		price := "1234.50"
		if locale != "en-US" {
			price = "1234,50"
		}
		res = request("POST", "/marketplace/"+locale+"/item_1", (url.Values{"email": {"x@y"}, "target_price": {price}}).Encode())
		if res.Code != 200 || !strings.Contains(res.Body.String(), "x@y") || !strings.Contains(res.Body.String(), "data-listing-id") {
			t.Fatal(res.Code, res.Body.String())
		}
		res = request("POST", "/marketplace/"+locale+"/item_1", "email=bad&target_price=1")
		if res.Code != 200 || !strings.Contains(res.Body.String(), marketplaceLabels[locale]["invalid_email"]) {
			t.Fatal(res.Body.String())
		}
	}
	a := request("GET", "/api/marketplace/item_1", "")
	b := request("GET", "/api/marketplace/item_1", "")
	var x, y marketplaceRecord
	if json.Unmarshal(a.Body.Bytes(), &x) != nil || json.Unmarshal(b.Body.Bytes(), &y) != nil || x.Title == y.Title || x.Listings[0].PriceMinor == nil {
		t.Fatal("numeric JSON or HTTP cache")
	}
	if res := request("GET", "/marketplace/es-ES/item_1", ""); res.Code != 400 {
		t.Fatal(res.Code)
	}
	if _, err := source.get(context.Background(), "item/1"); err != nil {
		t.Fatal(err)
	}
	status = 404
	for _, path := range []string{"/marketplace/en-US/item_1", "/api/marketplace/item_1"} {
		if res := request("GET", path, ""); res.Code != 404 {
			t.Fatal(res.Code)
		}
	}
	status = 503
	if res := request("GET", "/marketplace/en-US/item_1", ""); res.Code != 502 {
		t.Fatal(res.Code)
	}
	before := calls
	req := httptest.NewRequest("POST", "/marketplace/en-US/item_1", nil)
	req.Header.Set("Origin", "https://attacker.example")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != 403 || calls != before {
		t.Fatal("CSRF")
	}
}
