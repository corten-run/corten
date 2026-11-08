package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/bojanz/currency"
	"github.com/gin-gonic/gin"
	"github.com/nicksnyder/go-i18n/v2/i18n"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	localnumber "golang.org/x/text/number"
)

//go:embed marketplace-labels.json
var marketplaceLabelsJSON []byte
var marketplaceLabels = func() map[string]map[string]string {
	var labels map[string]map[string]string
	if err := json.Unmarshal(marketplaceLabelsJSON, &labels); err != nil {
		panic(err)
	}
	return labels
}()

var marketplacePluralCatalog = func() *i18n.Bundle {
	bundle := i18n.NewBundle(language.AmericanEnglish)
	for locale, words := range marketplaceLabels {
		bundle.MustAddMessages(language.MustParse(locale), &i18n.Message{
			ID: "marketplace.listing", One: words["listing_one"], Many: words["listing_many"], Other: words["listing_other"],
		})
	}
	return bundle
}()

type marketplaceCategory struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}
type marketplaceField struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type marketplaceSummary struct {
	LowestMinor *int64 `json:"lowest_minor"`
	Count       int64  `json:"count"`
	Quantity    int64  `json:"quantity"`
}
type marketplaceListing struct {
	ID               string `json:"id"`
	Seller           string `json:"seller"`
	RatingHundredths *int64 `json:"rating_hundredths"`
	Reviews          int64  `json:"reviews"`
	Condition        string `json:"condition"`
	ShipsFrom        string `json:"ships_from"`
	Quantity         int64  `json:"quantity"`
	PriceMinor       *int64 `json:"price_minor"`
}
type marketplaceOffer struct {
	ID         string `json:"id"`
	Buyer      string `json:"buyer"`
	Condition  string `json:"condition"`
	Quantity   int64  `json:"quantity"`
	PriceMinor *int64 `json:"price_minor"`
}
type marketplaceLine struct {
	ID       string `json:"id"`
	ItemID   string `json:"item_id"`
	Title    string `json:"title"`
	Quantity int64  `json:"quantity"`
}
type marketplaceRecord struct {
	ID          string                `json:"id"`
	Title       string                `json:"title"`
	Subtitle    *string               `json:"subtitle"`
	Description string                `json:"description"`
	Categories  []marketplaceCategory `json:"categories"`
	Badges      []string              `json:"badges"`
	Tags        []string              `json:"tags"`
	Images      []string              `json:"images"`
	Fields      []marketplaceField    `json:"fields"`
	Summary     *marketplaceSummary   `json:"summary"`
	Listings    []marketplaceListing  `json:"listings"`
	Offers      []marketplaceOffer    `json:"offers"`
	Contents    []marketplaceLine     `json:"contents"`
	IncludedIn  []marketplaceLine     `json:"included_in"`
}

func (r *marketplaceRecord) validate() error {
	if r == nil || r.ID == "" || r.Categories == nil || r.Badges == nil || r.Tags == nil || r.Images == nil ||
		r.Fields == nil || r.Listings == nil || r.Offers == nil || r.Contents == nil || r.IncludedIn == nil {
		return fmt.Errorf("invalid marketplace record")
	}
	if r.Summary != nil && (r.Summary.Count < 0 || r.Summary.Quantity < 0) {
		return fmt.Errorf("invalid marketplace summary")
	}
	for _, row := range r.Listings {
		if row.Quantity < 0 || row.Reviews < 0 || (row.RatingHundredths != nil && (*row.RatingHundredths < 0 || *row.RatingHundredths > 500)) {
			return fmt.Errorf("invalid marketplace listing")
		}
	}
	for _, row := range r.Offers {
		if row.Quantity < 0 {
			return fmt.Errorf("invalid marketplace offer")
		}
	}
	for _, lines := range [][]marketplaceLine{r.Contents, r.IncludedIn} {
		for _, row := range lines {
			if row.Quantity < 0 {
				return fmt.Errorf("invalid marketplace quantity")
			}
		}
	}
	return nil
}

type marketplaceSource struct {
	fixture map[string]*marketplaceRecord
	client  *http.Client
	base    string
}

func newMarketplaceSource() (*marketplaceSource, error) {
	s := &marketplaceSource{base: strings.TrimRight(envOr("API_BASE", "http://localhost:8080"), "/")}
	if os.Getenv("MARKETPLACE_SOURCE") == "fixture" {
		file, err := os.Open(envOr("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json"))
		if err != nil {
			return nil, err
		}
		defer file.Close()
		if err := json.NewDecoder(file).Decode(&s.fixture); err != nil {
			return nil, err
		}
		if s.fixture == nil {
			return nil, fmt.Errorf("missing marketplace fixture")
		}
		for _, record := range s.fixture {
			if err := record.validate(); err != nil {
				return nil, err
			}
		}
	} else {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConnsPerHost = transport.MaxIdleConns
		s.client = &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}
	}
	return s, nil
}
func (s *marketplaceSource) get(ctx context.Context, id string) (*marketplaceRecord, error) {
	if s.fixture != nil {
		return s.fixture[id], nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/marketplace/records/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("marketplace API: %s", res.Status)
	}
	var record marketplaceRecord
	if err := json.NewDecoder(res.Body).Decode(&record); err != nil {
		return nil, err
	}
	if err := record.validate(); err != nil {
		return nil, err
	}
	return &record, nil
}

type marketplaceFormat struct {
	locale  string
	plurals *i18n.Localizer
	printer *message.Printer
	money   *currency.Formatter
}

func newMarketplaceFormat(locale string) *marketplaceFormat {
	f := currency.NewFormatter(currency.NewLocale(locale))
	f.MinDigits = 2
	f.MaxDigits = 2
	tag := language.MustParse(locale)
	return &marketplaceFormat{locale, i18n.NewLocalizer(marketplacePluralCatalog, locale), message.NewPrinter(tag), f}
}
func (f *marketplaceFormat) Money(minor *int64) string {
	if minor == nil {
		return "—"
	}
	amount, _ := currency.NewAmount(strconv.FormatInt(*minor, 10), "USD")
	amount, _ = amount.Div("100")
	return f.money.Format(amount)
}
func (f *marketplaceFormat) Count(n int64) string {
	return f.printer.Sprintf("%v", localnumber.Decimal(n, localnumber.MaxFractionDigits(0)))
}
func (f *marketplaceFormat) Rating(n int64) string {
	// Round integral hundredths to tenths, half away, before locale-aware presentation.
	rounded := float64((n+5)/10) / 10
	return f.printer.Sprintf("%v", localnumber.Decimal(rounded, localnumber.MinFractionDigits(0), localnumber.MaxFractionDigits(1)))
}
func (f *marketplaceFormat) Listings(n int64) string {
	word := f.plurals.MustLocalize(&i18n.LocalizeConfig{MessageID: "marketplace.listing", PluralCount: n})
	return f.Count(n) + " " + word
}

var marketplaceDecimal = regexp.MustCompile(`^[0-9]+(?:[.,][0-9]+)?$`)

func (f *marketplaceFormat) Alert(title, email, target string) string {
	words := marketplaceLabels[f.locale]
	if !strings.Contains(email, "@") {
		return words["invalid_email"]
	}
	target = strings.TrimSpace(target)
	if !marketplaceDecimal.MatchString(target) || (f.locale == "en-US" && strings.Contains(target, ",")) ||
		(f.locale != "en-US" && strings.Contains(target, ".")) {
		return words["invalid_price"]
	}
	amount, err := f.money.Parse(target, "USD")
	if err != nil || !amount.IsPositive() {
		return words["invalid_price"]
	}
	return strings.NewReplacer("{email}", email, "{title}", title, "{price}", f.money.Format(amount)).Replace(words["alert_set"])
}

type marketplaceView struct {
	Record                            *marketplaceRecord
	Locale                            string
	Words                             map[string]string
	Format                            *marketplaceFormat
	Seller, Sort, Path, More, Message string
	Listings                          []marketplaceListing
	Offers                            []marketplaceOffer
}

func marketplaceURL(locale, id string) string {
	return "/marketplace/" + locale + "/" + url.PathEscape(id)
}
func newMarketplaceView(record *marketplaceRecord, locale string, query url.Values) *marketplaceView {
	v := &marketplaceView{Record: record, Locale: locale, Words: marketplaceLabels[locale], Format: newMarketplaceFormat(locale),
		Seller: query.Get("seller"), Sort: "asc", Path: marketplaceURL(locale, record.ID), Offers: record.Offers}
	if query.Get("sort") == "desc" {
		v.Sort = "desc"
	}
	for _, row := range record.Listings {
		if strings.HasPrefix(row.Seller, v.Seller) {
			v.Listings = append(v.Listings, row)
		}
	}
	sort.SliceStable(v.Listings, func(i, j int) bool {
		a, b := v.Listings[i].PriceMinor, v.Listings[j].PriceMinor
		if a == nil {
			return false
		}
		if b == nil {
			return true
		}
		if v.Sort == "desc" {
			return *a > *b
		}
		return *a < *b
	})
	if query.Get("offers") != "all" && len(v.Offers) > 5 {
		v.Offers = v.Offers[:5]
		v.More = v.Path + "?" + (url.Values{"seller": {v.Seller}, "sort": {v.Sort}, "offers": {"all"}}).Encode()
	}
	return v
}
func (s *marketplaceSource) routes(r *gin.Engine) {
	page := func(c *gin.Context) {
		locale := c.Param("locale")
		if marketplaceLabels[locale] == nil {
			c.Status(http.StatusBadRequest)
			return
		}
		if c.Request.Method == http.MethodPost {
			origin := c.GetHeader("Origin")
			scheme := "http"
			if c.Request.TLS != nil {
				scheme = "https"
			}
			if c.GetHeader("Sec-Fetch-Site") == "cross-site" || (origin != "" && origin != scheme+"://"+c.Request.Host) {
				c.Status(http.StatusForbidden)
				return
			}
		}
		record, err := s.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusBadGateway, err)
			return
		}
		if record == nil {
			render(c, http.StatusNotFound, notFoundPage())
			return
		}
		view := newMarketplaceView(record, locale, c.Request.URL.Query())
		if c.Request.Method == http.MethodPost {
			view.Message = view.Format.Alert(record.Title, c.PostForm("email"), c.PostForm("target_price"))
		}
		c.Header("Cache-Control", "no-store")
		render(c, http.StatusOK, marketplacePage(view))
	}
	r.GET("/marketplace/:locale/:id", page)
	r.POST("/marketplace/:locale/:id", page)
	r.GET("/api/marketplace/:id", func(c *gin.Context) {
		record, err := s.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusBadGateway, err)
			return
		}
		if record == nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, record)
	})
	r.StaticFile("/marketplace.css", "static/marketplace.css")
}
