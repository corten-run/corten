package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

type catalogField struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type catalogRelated struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type catalogRecord struct {
	ID          string           `json:"id"`
	Title       string           `json:"title"`
	Subtitle    string           `json:"subtitle"`
	Description string           `json:"description"`
	Tags        []string         `json:"tags"`
	Fields      []catalogField   `json:"fields"`
	Related     []catalogRelated `json:"related"`
}

func (r *catalogRecord) validate() error {
	if r == nil || r.Tags == nil || r.Fields == nil || r.Related == nil {
		return fmt.Errorf("invalid catalog record: arrays are required")
	}
	return nil
}

func (r *catalogRecord) matchingFields(prefix string) []catalogField {
	fields := make([]catalogField, 0, len(r.Fields))
	for _, field := range r.Fields {
		if strings.HasPrefix(field.Name, prefix) {
			fields = append(fields, field)
		}
	}
	return fields
}

type catalogSource struct {
	fixture map[string]*catalogRecord
	client  *http.Client
	base    string
}

func newCatalogSource() (*catalogSource, error) {
	s := &catalogSource{base: strings.TrimRight(envOr("API_BASE", "http://localhost:8080"), "/")}
	if os.Getenv("CATALOG_SOURCE") == "fixture" {
		file, err := os.Open(envOr("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json"))
		if err != nil {
			return nil, err
		}
		defer file.Close()
		if err := json.NewDecoder(file).Decode(&s.fixture); err != nil {
			return nil, err
		}
		if s.fixture == nil {
			return nil, fmt.Errorf("missing catalog fixture")
		}
		for _, record := range s.fixture {
			if err := record.validate(); err != nil {
				return nil, err
			}
		}
	} else {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConnsPerHost = transport.MaxIdleConns
		s.client = &http.Client{Transport: transport}
	}
	return s, nil
}

func (s *catalogSource) get(ctx context.Context, id string) (*catalogRecord, error) {
	if s.fixture != nil {
		return s.fixture[id], nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/catalog/records/"+url.PathEscape(id), nil)
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
		return nil, fmt.Errorf("catalog API: %s", res.Status)
	}
	var record catalogRecord
	if err := json.NewDecoder(res.Body).Decode(&record); err != nil {
		return nil, err
	}
	if err := record.validate(); err != nil {
		return nil, err
	}
	return &record, nil
}

func (s *catalogSource) routes(r *gin.Engine) {
	r.GET("/catalog/:id", func(c *gin.Context) {
		record, err := s.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusBadGateway, err)
			return
		}
		if record == nil {
			render(c, http.StatusNotFound, notFoundPage())
			return
		}
		render(c, http.StatusOK, catalogPage(record, c.Query("field")))
	})
	r.GET("/api/catalog/:id", func(c *gin.Context) {
		record, err := s.get(c.Request.Context(), c.Param("id"))
		if err != nil {
			_ = c.AbortWithError(http.StatusBadGateway, err)
			return
		}
		if record == nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.JSON(http.StatusOK, record)
	})
}

func catalogURL(id string) string { return "/catalog/" + url.PathEscape(id) }
