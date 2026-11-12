package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestNativeAlertHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	source := &marketplaceSource{fixture: map[string]*marketplaceRecord{"item_1": sampleMarketplace()}}
	source.routes(router)
	server := httptest.NewServer(router)
	defer server.Close()
	client := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar, Timeout: 10 * time.Second}
	}
	a, b := client(), client()
	read := func(c *http.Client) []storedAlert {
		t.Helper()
		res, err := c.Get(server.URL + "/api/alerts")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-store" || len(res.Cookies()) != 0 {
			t.Fatal(res.Status, res.Header)
		}
		var rows []storedAlert
		if err := json.NewDecoder(res.Body).Decode(&rows); err != nil || rows == nil {
			t.Fatal(rows, err)
		}
		return rows
	}
	post := func(c *http.Client, path, email, price, origin string) *http.Response {
		t.Helper()
		request, _ := http.NewRequest("POST", server.URL+path, strings.NewReader((url.Values{"email": {email}, "target_price": {price}}).Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		res, err := c.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		return res
	}
	if len(read(a)) != 0 || len(read(b)) != 0 {
		t.Fatal("fresh sessions")
	}
	for i, tag := range []string{"en-US", "fr-FR", "de-DE"} {
		price := "12.34"
		if i > 0 {
			price = "12,34"
		}
		res := post(a, "/marketplace/"+tag+"/item_1", fmt.Sprintf("person%d@example.test", i), price, server.URL)
		if res.StatusCode != 200 {
			t.Fatal(res.Status)
		}
		if i == 0 {
			cookies := res.Cookies()
			if len(cookies) != 1 || cookies[0].Name != alertCookie || len(cookies[0].Value) != 64 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Secure || cookies[0].Domain != "" || cookies[0].Path != "/" || cookies[0].MaxAge != 0 {
				t.Fatal(cookies)
			}
		} else if len(res.Cookies()) != 0 {
			t.Fatal("session rotated on accepted post")
		}
	}
	want := []storedAlert{{"item_1", "person0@example.test", 1234}, {"item_1", "person1@example.test", 1234}, {"item_1", "person2@example.test", 1234}}
	if got := read(a); !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	for _, row := range []struct {
		path, email, price, origin string
		status                     int
	}{
		{"/marketplace/en-US/item_1", "bad", "1", server.URL, 200},
		{"/marketplace/fr-FR/item_1", "x@y", "1.25", server.URL, 200},
		{"/marketplace/en-US/missing", "x@y", "1", server.URL, 404},
		{"/marketplace/es-ES/item_1", "x@y", "1", server.URL, 400},
		{"/marketplace/en-US/item_1", "x@y", "1", "https://attacker.invalid", 403},
		{"/marketplace/en-US/item_1?email=x%40y&target_price=1", "", "", server.URL, 200},
	} {
		if res := post(a, row.path, row.email, row.price, row.origin); res.StatusCode != row.status || len(res.Cookies()) != 0 {
			t.Fatal(res.Status, res.Header)
		}
		if got := read(a); !reflect.DeepEqual(got, want) {
			t.Fatal("rejection mutated", got)
		}
	}
	if len(read(b)) != 0 {
		t.Fatal("client isolation")
	}
	if res := post(b, "/marketplace/en-US/item_1", "second@example.test", "3.21", server.URL); res.StatusCode != 200 {
		t.Fatal(res.Status)
	}
	if len(read(b)) != 1 || !reflect.DeepEqual(read(a), want) {
		t.Fatal("independent clients")
	}
	var workers sync.WaitGroup
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			res := post(a, "/marketplace/en-US/item_1", fmt.Sprintf("concurrent%d@example.test", i), "1.23", server.URL)
			if res.StatusCode != 200 {
				t.Error(res.Status)
			}
		}(i)
	}
	workers.Wait()
	rows := read(a)
	if len(rows) != 19 {
		t.Fatal("lost concurrent write", len(rows))
	}
	seen := map[string]bool{}
	for _, row := range rows {
		if seen[row.Email] {
			t.Fatal("duplicate", row.Email)
		}
		seen[row.Email] = true
	}
}

func TestAlertMinor(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  int64
		ok    bool
	}{
		{"12.34", 1234, true}, {"00012.34", 1234, true}, {"0.009", 1, true}, {"1", 100, true}, {"92233720368547758.07", 9223372036854775807, true}, {"92233720368547758.08", 0, false},
	} {
		got, ok := alertMinor(tc.input)
		if got != tc.want || ok != tc.ok {
			t.Fatal(tc, got, ok)
		}
	}
}

func TestAlertSessionExpiryCapacityAndTLS(t *testing.T) {
	store := &alertStore{}
	request := httptest.NewRequest("POST", "https://market.test/marketplace/en-US/item_1", nil)
	request.AddCookie(&http.Cookie{Name: alertCookie, Value: "chosen"})
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = request
	row := storedAlert{"item_1", "person@example.test", 1234}
	if err := store.append(context, row); err != nil {
		t.Fatal(err)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || cookies[0].Value == "chosen" {
		t.Fatal(cookies)
	}
	id := cookies[0].Value
	request = httptest.NewRequest("GET", "https://market.test/api/alerts", nil)
	request.AddCookie(cookies[0])
	store.sessions[id].expires = time.Now().Add(-time.Second)
	response = httptest.NewRecorder()
	context, _ = gin.CreateTestContext(response)
	context.Request = request
	store.read(context)
	if response.Body.String() != "[]" || len(store.sessions[id].rows) != 1 {
		t.Fatal("GET mutated expired session")
	}
	store.sessions[id].expires = time.Now().Add(time.Hour)
	store.sessions[id].rows = make([]storedAlert, 1024)
	if err := store.append(context, row); err == nil || len(store.sessions[id].rows) != 1024 {
		t.Fatal("capacity must not evict or append")
	}
}
