require "net/http"

module MarketplaceSource
  BASE = ENV.fetch("API_BASE", "http://localhost:8080").delete_suffix("/")

  def self.fixture
    return @fixture if defined?(@fixture)
    @fixture = if ENV["MARKETPLACE_SOURCE"] == "fixture"
      JSON.parse(File.read(ENV.fetch("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json")))
    end
  end

  def self.get(id)
    return fixture[id] if fixture
    uri = URI("#{BASE}/marketplace/records/#{ERB::Util.url_encode(id)}")
    http = Thread.current[:marketplace_api] ||= Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https")
    response = http.get(uri.request_uri)
    return nil if response.code == "404"
    raise "Marketplace API returned #{response.code}" unless response.is_a?(Net::HTTPSuccess)
    JSON.parse(response.body)
  end
end
