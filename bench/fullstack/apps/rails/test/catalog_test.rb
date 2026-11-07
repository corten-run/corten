ENV["RAILS_ENV"] = "test"
require_relative "../config/environment"
require "minitest/autorun"
require "action_dispatch/testing/integration"

class CatalogTest < ActionDispatch::IntegrationTest
  RECORD = {
    "id" => "record_1", "title" => '<script>"title"</script>', "subtitle" => "A & B", "description" => "001.50",
    "tags" => ["<tag>", "second"],
    "fields" => [{ "name" => "Access", "value" => "<north>" }, { "name" => "access", "value" => "south" }],
    "related" => [{ "id" => "record_2", "title" => "<Related>" }]
  }.freeze
  EMPTY = RECORD.merge("id" => "record_2", "tags" => [], "fields" => [], "related" => []).freeze

  def setup
    @fixture = CatalogSource.fixture
    CatalogSource.instance_variable_set(:@fixture, {
      "record_1" => CatalogRecord.from_json(RECORD), "record_2" => CatalogRecord.from_json(EMPTY)
    })
  end

  def teardown
    CatalogSource.instance_variable_set(:@fixture, @fixture)
    Thread.current[:catalog_api] = nil
  end

  def test_page_filter_and_escaping
    get "/catalog/record_1", params: { field: "A" }
    assert_response :success
    assert_select "main article[aria-label='Catalog record'] h1", text: RECORD["title"]
    assert_select "article script", count: 0
    assert_select "tbody tr", count: 1
    assert_select "tbody td", text: "<north>"
    assert_select "form[method=get][action='/catalog/record_1'] input[name=field][value=A]"
    assert_select "nav a[href='/catalog/record_2']", text: "<Related>"
    assert_select "link[href*='catalog']"
    get "/catalog/record_1", params: { field: ' <"' }
    assert_select "input[name=field]" do |nodes|
      assert_equal ' <"', nodes.first["value"]
    end
    assert_select "tbody tr", count: 0
    get "/catalog/record_1"
    assert_select "tbody tr", count: 2
  end

  def test_json_empty_lists_and_missing_records
    get "/api/catalog/record_1"
    assert_equal RECORD, response.parsed_body
    get "/catalog/record_2"
    assert_select "ul[aria-label=Tags]", count: 1
    assert_select "ul[aria-label=Tags] li", count: 0
    assert_select "tbody", count: 1
    assert_select "tbody tr", count: 0
    assert_select "nav[aria-label='Related records'] ul", count: 1
    get "/api/catalog/record_2"
    assert_equal EMPTY, response.parsed_body
    ["/catalog/missing", "/api/catalog/missing"].each do |path|
      get path
      assert_response :not_found
    end
  end

  def test_api_fetches_and_parses_on_each_call
    CatalogSource.instance_variable_set(:@fixture, nil)
    bodies = [JSON.generate(RECORD), JSON.generate(RECORD.merge("title" => "changed"))]
    paths = []
    http = Object.new
    http.define_singleton_method(:get) do |path|
      paths << path
      Net::HTTPOK.new("1.1", "200", "OK").tap do |response|
        response.instance_variable_set(:@read, true)
        response.body = bodies.shift
      end
    end
    Thread.current[:catalog_api] = http
    assert_equal RECORD["title"], CatalogSource.get("record_1").title
    assert_equal "changed", CatalogSource.get("record_1").title
    assert_equal ["/catalog/records/record_1"] * 2, paths
    http.define_singleton_method(:get) { |_| Net::HTTPNotFound.new("1.1", "404", "missing") }
    assert_nil CatalogSource.get("missing")
    http.define_singleton_method(:get) { |_| Net::HTTPServiceUnavailable.new("1.1", "503", "failed") }
    assert_raises(RuntimeError) { CatalogSource.get("record_1") }
  end

  def test_fixture_is_read_once
    require "tempfile"
    Tempfile.create("catalog") do |file|
      file.write(JSON.generate("record_1" => RECORD))
      file.flush
      previous = ENV.values_at("CATALOG_SOURCE", "CATALOG_FIXTURE_PATH")
      begin
        ENV["CATALOG_SOURCE"] = "fixture"
        ENV["CATALOG_FIXTURE_PATH"] = file.path
        CatalogSource.remove_instance_variable(:@fixture)
        CatalogSource.fixture
        file.truncate(0)
        assert_equal RECORD["title"], CatalogSource.get("record_1").title
        assert_nil CatalogSource.get("missing")
      ensure
        ENV["CATALOG_SOURCE"], ENV["CATALOG_FIXTURE_PATH"] = previous
      end
    end
  end

  def test_invalid_records_fail_instead_of_coercing
    [RECORD.merge("subtitle" => 123), RECORD.merge("tags" => nil),
      RECORD.merge("fields" => [{ "name" => "a", "value" => 1 }])].each do |value|
      assert_raises(ArgumentError) { CatalogRecord.from_json(value) }
    end
  end
end
