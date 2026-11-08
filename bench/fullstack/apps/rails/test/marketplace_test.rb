ENV["RAILS_ENV"] = "test"
require_relative "../config/environment"
require "minitest/autorun"
require "action_dispatch/testing/integration"

class MarketplaceTest < ActionDispatch::IntegrationTest
  RECORDS = JSON.parse(File.read(File.join(__dir__, "marketplace_fixture.json"))).freeze

  def setup
    @original = MarketplaceSource.fixture
    @records = Marshal.load(Marshal.dump(RECORDS))
    MarketplaceSource.instance_variable_set(:@fixture, @records)
  end

  def teardown
    MarketplaceSource.instance_variable_set(:@fixture, @original)
    Thread.current[:marketplace_api] = nil
    ActionController::Base.allow_forgery_protection = false
  end

  def test_native_pages_json_and_empty_record
    MarketplaceFormat::LOCALES.each_key do |locale|
      get "/marketplace/#{locale}/item_1"
      assert_response :success
      assert_select "html[lang='#{locale}']"
      assert_select "main article.marketplace", count: 1
      assert_select "article h1", text: RECORDS["item_1"]["title"]
      assert_select "article script", count: 0
      assert_select ".marketplace__image", count: 2
      assert_select "[data-offer-id]", count: 5
      assert_select ".marketplace__contents a[href='/marketplace/#{locale}/item_2']"
      assert_select "link[href*='marketplace']"
      get "/api/marketplace/item_1"
      assert_equal RECORDS["item_1"], response.parsed_body
    end
    @records["item_1"]["summary"]["lowest_minor"] = 1
    get "/marketplace/en-US/item_1"
    assert_select ".marketplace__summary strong", text: "$0.01"
    get "/marketplace/de-DE/item_2"
    assert_select ".marketplace__subtitle", count: 0
    assert_select ".marketplace__badges", count: 1
    assert_select ".marketplace__badges li", count: 0
    assert_select ".marketplace__summary", text: MarketplaceFormat::LABELS["de-DE"]["no_listings"]
    assert_select ".marketplace__contents ul", count: 1
    assert_select ".marketplace__included ul", count: 1
  end

  def test_stable_sort_literal_filter_and_show_all
    get "/marketplace/fr-FR/item_1", params: { sort: "desc", offers: "all" }
    assert_select "[data-listing-id]" do |rows|
      assert_equal %w[listing_5 listing_4 listing_3 listing_8 listing_2 listing_1 listing_0 listing_6 listing_7], rows.map { |row| row["data-listing-id"] }
    end
    assert_select "[data-offer-id]", count: 7
    get "/marketplace/en-US/item_1", params: { seller: " Alice", sort: "desc" }
    assert_select "[data-listing-id]", count: 1
    assert_select "[data-listing-id='listing_8']"
    assert_select ".marketplace__more" do |links|
      query = Rack::Utils.parse_query(URI(links.first["href"]).query)
      assert_equal({ "seller" => " Alice", "sort" => "desc", "offers" => "all" }, query)
    end
    get "/marketplace/en-US/item_1", params: { seller: "alice" }
    assert_select "[data-listing-id]", count: 0
  end

  def test_formatting_boundaries_and_post_results
    expected = {
      "en-US" => ["$0.00", "$0.01", "$0.10", "$1.25", "$1,234.50", "$1,234,567.89", "-$1,234.50"],
      "fr-FR" => ["0,00 $US", "0,01 $US", "0,10 $US", "1,25 $US", "1 234,50 $US", "1 234 567,89 $US", "-1 234,50 $US"],
      "de-DE" => ["0,00 $", "0,01 $", "0,10 $", "1,25 $", "1.234,50 $", "1.234.567,89 $", "-1.234,50 $"]
    }
    expected.each do |locale, prices|
      fmt = MarketplaceFormat.new(locale)
      assert_equal prices, [0, 1, 10, 125, 123450, 123456789, -123450].map { |n| fmt.money(n).tr("\u00a0\u202f", "  ") }
      assert_equal(locale == "en-US" ? %w[0 4 4.3 4.8 5] : %w[0 4 4,3 4,8 5], [0, 400, 425, 475, 499].map { |n| fmt.rating(n) })
      [0, 1, 2, 1000, 1000000].each do |n|
        category = if locale == "fr-FR" && n == 1000000 then "many"
          elsif n == 1 || (locale == "fr-FR" && n == 0) then "one"
          else "other" end
        assert fmt.count(n).end_with?(" #{fmt.labels.fetch("listing_#{category}")}")
      end
      path = "/marketplace/#{locale}/item_1"
      target = locale == "en-US" ? "12.50" : "12,50"
      post path, params: { email: "<a>@b", target_price: target }
      assert_response :success
      assert_select ".marketplace__message", text: fmt.alert("<a>@b", target, RECORDS["item_1"]["title"])
      assert_select ".marketplace__message script", count: 0
      [["invalid", target, "invalid_email"], ["a@b", "0", "invalid_price"], ["a@b", "12bad", "invalid_price"], ["a@b", "NaN", "invalid_price"]].each do |email, price, key|
        post path, params: { email: email, target_price: price }
        assert_response :success
        assert_select ".marketplace__message", text: fmt.labels.fetch(key)
      end
    end
  end

  def test_statuses_and_csrf
    get "/marketplace/es-ES/item_1"
    assert_response :bad_request
    ["/marketplace/en-US/missing", "/api/marketplace/missing"].each do |path|
      get path
      assert_response :not_found
    end
    ActionController::Base.allow_forgery_protection = true
    get "/marketplace/en-US/item_1"
    token = css_select("input[name=authenticity_token]").first["value"]
    post "/marketplace/en-US/item_1", params: { email: "a@b", target_price: "12.50", authenticity_token: token }
    assert_response :success
    post "/marketplace/en-US/item_1", params: { email: "a@b", target_price: "12.50" }
    assert_response 422
  end

  def test_http_fetches_once_per_request_and_never_caches_records
    MarketplaceSource.instance_variable_set(:@fixture, nil)
    bodies = [RECORDS["item_1"], RECORDS["item_2"]].map { |record| JSON.generate(record) }
    paths = []
    http = Object.new
    http.define_singleton_method(:get) do |path|
      paths << path
      Net::HTTPOK.new("1.1", "200", "OK").tap do |response|
        response.instance_variable_set(:@read, true)
        response.body = bodies.shift
      end
    end
    Thread.current[:marketplace_api] = http
    get "/marketplace/en-US/item_1"
    assert_response :success
    get "/api/marketplace/item_1"
    assert_equal RECORDS["item_2"], response.parsed_body
    assert_equal ["/marketplace/records/item_1"] * 2, paths
    http.define_singleton_method(:get) { |path| paths << path; Net::HTTPNotFound.new("1.1", "404", "missing") }
    assert_nil MarketplaceSource.get("a/b ?")
    assert_equal "/marketplace/records/a%2Fb%20%3F", paths.last
    http.define_singleton_method(:get) { |_| Net::HTTPServiceUnavailable.new("1.1", "503", "failed") }
    assert_raises(RuntimeError) { MarketplaceSource.get("item_1") }
  end

  def test_fixture_is_parsed_once
    require "tempfile"
    Tempfile.create("marketplace") do |file|
      file.write(JSON.generate(RECORDS))
      file.flush
      previous = ENV.values_at("MARKETPLACE_SOURCE", "MARKETPLACE_FIXTURE_PATH")
      begin
        ENV["MARKETPLACE_SOURCE"], ENV["MARKETPLACE_FIXTURE_PATH"] = "fixture", file.path
        MarketplaceSource.remove_instance_variable(:@fixture)
        MarketplaceSource.fixture
        file.truncate(0)
        assert_equal RECORDS["item_1"], MarketplaceSource.get("item_1")
        assert_nil MarketplaceSource.get("missing")
      ensure
        ENV["MARKETPLACE_SOURCE"], ENV["MARKETPLACE_FIXTURE_PATH"] = previous
      end
    end
  end
end
