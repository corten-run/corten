package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The item API's response, the fields the page uses. Values whose JSON type varies stay raw.
type apiItem struct {
	CatalogItemID      json.RawMessage   `json:"catalog_item_id"`
	Title              json.RawMessage   `json:"title"`
	Subtitle           json.RawMessage   `json:"subtitle"`
	Description        json.RawMessage   `json:"description"`
	DisplayBadges      []apiBadge        `json:"display_badges"`
	Tags               []json.RawMessage `json:"tags"`
	Categories         []apiCategory     `json:"categories"`
	FieldValues        []apiField        `json:"field_values"`
	ImageURLs          []json.RawMessage `json:"image_urls"`
	MarketSummary      *apiSummary       `json:"market_summary"`
	MarketListings     []apiListing      `json:"market_listings"`
	OfferDemandMatches []apiOffer        `json:"offer_demand_matches"`
	Contents           []apiLine         `json:"contents"`
	IncludedIn         []apiLine         `json:"included_in"`
}

type apiBadge struct {
	Label json.RawMessage `json:"label"`
}

type apiCategory struct {
	Name json.RawMessage `json:"name"`
	Slug json.RawMessage `json:"slug"`
}

type apiField struct {
	FieldID   json.RawMessage `json:"fieldId"`
	FieldName json.RawMessage `json:"fieldName"`
	Value     json.RawMessage `json:"value"`
}

type apiSummary struct {
	LowestPriceAmount       json.RawMessage `json:"lowest_price_amount"`
	LowestPriceCurrencyCode json.RawMessage `json:"lowest_price_currency_code"`
	ActiveListingCount      json.RawMessage `json:"active_listing_count"`
	TotalVisibleQuantity    json.RawMessage `json:"total_visible_quantity"`
}

type apiListing struct {
	ListingID           json.RawMessage `json:"listing_id"`
	SellerDisplayName   json.RawMessage `json:"seller_display_name"`
	SellerAverageRating json.RawMessage `json:"seller_average_rating"`
	SellerReviewCount   json.RawMessage `json:"seller_review_count"`
	ProductSummary      json.RawMessage `json:"product_summary"`
	ShipFromCode        json.RawMessage `json:"ship_from_code"`
	VisibleQuantity     json.RawMessage `json:"visible_quantity"`
	PriceAmount         json.RawMessage `json:"price_amount"`
	PriceCurrencyCode   json.RawMessage `json:"price_currency_code"`
}

type apiOffer struct {
	OfferID           json.RawMessage `json:"offer_id"`
	BuyerDisplayName  json.RawMessage `json:"buyer_display_name"`
	ProductSummary    json.RawMessage `json:"product_summary"`
	QuantityRequested json.RawMessage `json:"quantity_requested"`
	PriceAmount       json.RawMessage `json:"price_amount"`
	PriceCurrencyCode json.RawMessage `json:"price_currency_code"`
}

type apiLine struct {
	LineID                 json.RawMessage `json:"line_id"`
	ContainedCatalogItemID json.RawMessage `json:"contained_catalog_item_id"`
	ContainerCatalogItemID json.RawMessage `json:"container_catalog_item_id"`
	ContainedItem          *apiLineItem    `json:"contained_item"`
	ContainerItem          *apiLineItem    `json:"container_item"`
	Quantity               json.RawMessage `json:"quantity"`
}

type apiLineItem struct {
	Title json.RawMessage `json:"title"`
}

// Same view model and rules as aspnet/Model.cs.
type itemView struct {
	ID          string        `json:"id"`
	Title       string        `json:"title"`
	Subtitle    *string       `json:"subtitle"`
	Description string        `json:"description"`
	Badges      []string      `json:"badges"`
	Tags        []string      `json:"tags"`
	Categories  []category    `json:"categories"`
	Fields      []field       `json:"fields"`
	Images      []string      `json:"images"`
	Summary     *summary      `json:"summary"`
	Listings    []listing     `json:"listings"`
	Offers      []offer       `json:"offers"`
	Contents    []contentLine `json:"contents"`
	IncludedIn  []contentLine `json:"included_in"`
}

type category struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type field struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type summary struct {
	Lowest   *string `json:"lowest"`
	Count    int64   `json:"count"`
	Quantity int64   `json:"quantity"`
}

type listing struct {
	ID         string  `json:"id"`
	Seller     string  `json:"seller"`
	Rating     *string `json:"rating"`
	Reviews    int64   `json:"reviews"`
	Condition  string  `json:"condition"`
	ShipsFrom  string  `json:"ships_from"`
	Quantity   int64   `json:"quantity"`
	Price      string  `json:"price"`
	PriceValue number  `json:"price_value"`
}

type offer struct {
	ID        string `json:"id"`
	Buyer     string `json:"buyer"`
	Condition string `json:"condition"`
	Quantity  int64  `json:"quantity"`
	Price     string `json:"price"`
}

type contentLine struct {
	ID       string `json:"id"`
	ItemID   string `json:"item_id"`
	Title    string `json:"title"`
	Quantity int64  `json:"quantity"`
}

// A price that may be missing: NaN, written as null in JSON (encoding/json rejects NaN).
type number float64

func (n number) MarshalJSON() ([]byte, error) {
	if math.IsNaN(float64(n)) || math.IsInf(float64(n), 0) {
		return []byte("null"), nil
	}
	return json.Marshal(float64(n))
}

func missing(v json.RawMessage) bool {
	return len(v) == 0 || bytes.Equal(v, []byte("null"))
}

// A value as text: a string's contents, any other value's JSON, nothing for null.
func text(v json.RawMessage) string {
	if missing(v) {
		return ""
	}
	if v[0] == '"' {
		var s string
		if json.Unmarshal(v, &s) == nil {
			return s
		}
	}
	return string(v)
}

// A string value, or nil for null or any other type.
func optText(v json.RawMessage) *string {
	if missing(v) || v[0] != '"' {
		return nil
	}
	s := text(v)
	return &s
}

func textOr(v json.RawMessage, fallback string) string {
	if s := optText(v); s != nil {
		return *s
	}
	return fallback
}

// A whole number, from a JSON number or a numeric string; fallback otherwise.
func integer(v json.RawMessage, fallback int64) int64 {
	if missing(v) {
		return fallback
	}
	if n, err := strconv.ParseInt(text(v), 10, 64); err == nil {
		return n
	}
	return fallback
}

func money(amount, code json.RawMessage) *string {
	if missing(amount) || missing(code) {
		return nil
	}
	var s string
	if text(code) == "USD" {
		s = "$" + text(amount)
	} else {
		s = text(amount) + " " + text(code)
	}
	return &s
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Each element of in mapped by f, never nil, so JSON writes [] for none.
func mapped[T, U any](in []T, f func(T) U) []U {
	out := make([]U, 0, len(in))
	for _, v := range in {
		out = append(out, f(v))
	}
	return out
}

func line(c apiLine, id json.RawMessage, item *apiLineItem) contentLine {
	title := text(id)
	if item != nil && !missing(item.Title) {
		title = text(item.Title)
	}
	return contentLine{ID: text(c.LineID), ItemID: text(id), Title: title, Quantity: integer(c.Quantity, 1)}
}

func fromAPI(a *apiItem) *itemView {
	v := &itemView{
		ID:          text(a.CatalogItemID),
		Title:       text(a.Title),
		Subtitle:    optText(a.Subtitle),
		Description: text(a.Description),
		Badges:      mapped(a.DisplayBadges, func(b apiBadge) string { return text(b.Label) }),
		Tags:        mapped(a.Tags, text),
		Categories:  mapped(a.Categories, func(c apiCategory) category { return category{text(c.Name), text(c.Slug)} }),
		Fields: mapped(a.FieldValues, func(f apiField) field {
			name := f.FieldName
			if missing(name) {
				name = f.FieldID
			}
			return field{text(name), text(f.Value)}
		}),
		Images: mapped(a.ImageURLs[:min(2, len(a.ImageURLs))], text),
		Listings: mapped(a.MarketListings, func(l apiListing) listing {
			price, err := strconv.ParseFloat(text(l.PriceAmount), 64)
			if err != nil {
				price = math.NaN()
			}
			return listing{
				ID:         text(l.ListingID),
				Seller:     textOr(l.SellerDisplayName, "Seller"),
				Rating:     optText(l.SellerAverageRating),
				Reviews:    integer(l.SellerReviewCount, 0),
				Condition:  text(l.ProductSummary),
				ShipsFrom:  text(l.ShipFromCode),
				Quantity:   integer(l.VisibleQuantity, 0),
				Price:      orEmpty(money(l.PriceAmount, l.PriceCurrencyCode)),
				PriceValue: number(price),
			}
		}),
		Offers: mapped(a.OfferDemandMatches, func(o apiOffer) offer {
			return offer{
				ID:        text(o.OfferID),
				Buyer:     textOr(o.BuyerDisplayName, "Buyer"),
				Condition: text(o.ProductSummary),
				Quantity:  integer(o.QuantityRequested, 0),
				Price:     orEmpty(money(o.PriceAmount, o.PriceCurrencyCode)),
			}
		}),
		Contents:   mapped(a.Contents, func(c apiLine) contentLine { return line(c, c.ContainedCatalogItemID, c.ContainedItem) }),
		IncludedIn: mapped(a.IncludedIn, func(c apiLine) contentLine { return line(c, c.ContainerCatalogItemID, c.ContainerItem) }),
	}
	if s := a.MarketSummary; s != nil {
		v.Summary = &summary{
			Lowest:   money(s.LowestPriceAmount, s.LowestPriceCurrencyCode),
			Count:    integer(s.ActiveListingCount, 0),
			Quantity: integer(s.TotalVisibleQuantity, 0),
		}
	}
	return v
}

func alertMessage(title, email, target string) string {
	price, err := strconv.ParseFloat(strings.TrimSpace(target), 64)
	if err != nil {
		price = math.NaN()
	}
	if !strings.Contains(email, "@") {
		return "Enter a valid email address."
	}
	if !(price > 0) {
		return "Enter a target price above zero."
	}
	return fmt.Sprintf("Alert set: we will email %s when %s drops below $%.2f.", email, title, price)
}

// A count as an English page writes it: digits grouped, and the word singular for one.
func counted(n int64, one, other string) string {
	digits := strconv.FormatInt(n, 10)
	var b strings.Builder
	for i, d := range digits {
		if i > 0 && d != '-' && digits[i-1] != '-' && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(d)
	}
	word := other
	if n == 1 {
		word = one
	}
	return b.String() + " " + word
}

// Cheapest first (a stable sort, a missing price first); "high to low" is that order reversed.
func sortedListings(listings []listing) []listing {
	sorted := slices.Clone(listings)
	slices.SortStableFunc(sorted, func(a, b listing) int { return cmp.Compare(a.PriceValue, b.PriceValue) })
	return sorted
}

func shownOffers(offers []offer, all bool) []offer {
	if all {
		return offers
	}
	return offers[:min(5, len(offers))]
}

func lowestText(s *summary) string {
	if s.Lowest == nil {
		return "—"
	}
	return *s.Lowest
}

func sellerText(l listing) string {
	if l.Rating == nil {
		return l.Seller
	}
	return fmt.Sprintf("%s · %s ★ (%d)", l.Seller, *l.Rating, l.Reviews)
}
