require "net/http"

module CatalogSource
  BASE = ENV.fetch("API_BASE", "http://localhost:8080").delete_suffix("/")

  def self.fixture
    return @fixture if defined?(@fixture)
    @fixture = if ENV["CATALOG_SOURCE"] == "fixture"
      JSON.parse(File.read(ENV.fetch("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json")))
        .transform_values { |value| CatalogRecord.from_json(value) }.freeze
    end
  end

  def self.get(id)
    return fixture[id] if fixture
    uri = URI("#{BASE}/catalog/records/#{ERB::Util.url_encode(id)}")
    http = Thread.current[:catalog_api] ||= Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https")
    response = http.get(uri.request_uri)
    return nil if response.code == "404"
    raise "catalog API returned #{response.code}" unless response.is_a?(Net::HTTPSuccess)
    CatalogRecord.from_json(JSON.parse(response.body))
  end
end
