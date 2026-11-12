defmodule ItemPage.MarketplaceTest do
  use ExUnit.Case, async: false
  import Phoenix.ConnTest
  @endpoint ItemPageWeb.Endpoint
  alias ItemPage.Marketplace
  alias ItemPage.MarketplaceFormat, as: F

  defmodule Upstream do
    def init(agent), do: agent

    def call(conn, agent) do
      {status, record} =
        Agent.get_and_update(agent, fn state ->
          {{state.status, state.record},
           %{state | requests: state.requests ++ [conn.request_path]}}
        end)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(status, Jason.encode!(record))
    end
  end

  defp spaces(s), do: String.replace(s, ["\u00a0", "\u202f"], " ")

  defp sample do
    %{
      "id" => "item_1",
      "title" => "<script> & Title",
      "subtitle" => nil,
      "description" => "Description",
      "categories" => [%{"name" => "Cards", "slug" => "cards"}],
      "badges" => [],
      "tags" => [],
      "images" => ["/one"],
      "fields" => [%{"name" => "Set", "value" => "<&>"}],
      "summary" => %{"lowest_minor" => -123_450, "count" => 1_000_000, "quantity" => 1000},
      "listings" => [
        row("a", "Alice", 100),
        row("b", "alice", nil),
        row("c", "Alice", 100),
        row("d", " Alice", -100)
      ],
      "offers" =>
        for(
          i <- 0..6,
          do: %{
            "id" => "o#{i}",
            "buyer" => "Buyer",
            "condition" => "NM",
            "quantity" => 1,
            "price_minor" => nil
          }
        ),
      "contents" => [
        %{"id" => "line", "item_id" => "item_2", "title" => "Other", "quantity" => 1000}
      ],
      "included_in" => []
    }
  end

  defp row(id, seller, price),
    do: %{
      "id" => id,
      "seller" => seller,
      "rating_hundredths" => 425,
      "reviews" => 1000,
      "condition" => "NM",
      "ships_from" => "US",
      "quantity" => 2,
      "price_minor" => price
    }

  setup do
    previous = :persistent_term.get(Marketplace, nil)
    :persistent_term.put(Marketplace, %{"item_1" => Marketplace.from_json(sample())})

    on_exit(fn ->
      if previous,
        do: :persistent_term.put(Marketplace, previous),
        else: :persistent_term.erase(Marketplace)
    end)

    :ok
  end

  test "locale currency, signed prices, half-away ratings and CLDR million plural" do
    assert F.money(-123_450, "en-US") == "-$1,234.50"
    assert spaces(F.money(123_450, "fr-FR")) == "1 234,50 $US"
    assert spaces(F.money(123_450, "de-DE")) == "1.234,50 $"
    assert F.listings(0, "fr-FR") == "0 annonce"
    assert spaces(F.listings(1_000_000, "fr-FR")) == "1 000 000 d’annonces"

    for locale <- ["en-US", "fr-FR", "de-DE"] do
      assert F.rating(499, locale) == "5"
      assert F.rating(425, locale) == if(locale == "en-US", do: "4.3", else: "4,3")
      assert F.rating(475, locale) == if(locale == "en-US", do: "4.8", else: "4,8")
      assert F.alert("bad", "1", "Title", locale) == F.labels(locale)["invalid_email"]
      assert F.alert("a@b", "0", "Title", locale) == F.labels(locale)["invalid_price"]
      assert F.alert("a@b", "NaN", "Title", locale) == F.labels(locale)["invalid_price"]
      target = if locale == "en-US", do: "1234.50", else: "1234,50"
      assert String.contains?(F.alert("a@b", target, "Title", locale), F.money(123_450, locale))
    end
  end

  test "stable price sort and case-sensitive untrimmed prefix" do
    assert Enum.map(Marketplace.listings(sample(), "Alice", "desc"), & &1["id"]) == ["a", "c"]

    assert Enum.map(Marketplace.listings(sample(), "", "desc"), & &1["id"]) == [
             "a",
             "c",
             "d",
             "b"
           ]

    assert Enum.map(Marketplace.listings(sample(), " ", "asc"), & &1["id"]) == ["d"]
  end

  test "native HEEx page, escaping, pagination, full numeric JSON, and status codes" do
    html = build_conn() |> get("/marketplace/fr-FR/item_1") |> html_response(200)
    assert html =~ "lang=\"fr-FR\""
    assert html =~ "&lt;script&gt; &amp; Title"
    refute html =~ "data-offer-id=\"o5\""
    assert html =~ "marketplace__more"
    assert html =~ "name=\"_csrf_token\""
    assert spaces(html) =~ "1 000 000 d’annonces"

    all =
      build_conn()
      |> get("/marketplace/de-DE/item_1?offers=all&seller=Alice&sort=desc")
      |> html_response(200)

    assert all =~ "data-offer-id=\"o6\""
    refute all =~ "data-listing-id=\"b\""
    assert build_conn() |> get("/api/marketplace/item_1") |> json_response(200) == sample()

    assert build_conn() |> get("/api/marketplace/missing") |> json_response(404) == %{
             "error" => "Not found"
           }

    assert build_conn()
           |> Plug.Conn.put_req_header("accept", "text/html")
           |> get("/api/marketplace/missing")
           |> response(404)

    assert build_conn() |> get("/marketplace/es-ES/item_1") |> response(400) ==
             "Unsupported locale"
  end

  test "ordinary localized form posts retain Phoenix CSRF tokens" do
    for locale <- ["en-US", "fr-FR", "de-DE"] do
      path = "/marketplace/#{locale}/item_1"
      initial = build_conn() |> get(path)
      document = initial |> html_response(200) |> LazyHTML.from_document()

      [token] =
        document |> LazyHTML.query("input[name=_csrf_token]") |> LazyHTML.attribute("value")

      target = if locale == "en-US", do: "1234.50", else: "1234,50"

      for {email, price} <- [{"bad", "1"}, {"a@b", "0"}, {"a@b", target}] do
        posted =
          initial
          |> recycle()
          |> post(path, %{"_csrf_token" => token, "email" => email, "target_price" => price})

        message =
          posted
          |> html_response(200)
          |> LazyHTML.from_document()
          |> LazyHTML.query(".marketplace__message")
          |> LazyHTML.text()

        assert message == F.alert(email, price, sample()["title"], locale)
      end
    end
  end

  test "HTTP source makes one uncached encoded read and preserves upstream failures" do
    :persistent_term.erase(Marketplace)
    agent = start_supervised!({Agent, fn -> %{status: 200, record: sample(), requests: []} end})
    server = start_supervised!({Bandit, plug: {Upstream, agent}, ip: {127, 0, 0, 1}, port: 0})
    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    previous = System.get_env("API_BASE")
    System.put_env("API_BASE", "http://127.0.0.1:#{port}")

    on_exit(fn ->
      if previous, do: System.put_env("API_BASE", previous), else: System.delete_env("API_BASE")
    end)

    assert Marketplace.get("a/b ?") == sample()
    Agent.update(agent, &%{&1 | record: Map.put(sample(), "title", "Fresh title")})
    assert Marketplace.get("a/b ?")["title"] == "Fresh title"

    assert Agent.get(agent, & &1.requests) ==
             List.duplicate("/marketplace/records/a%2Fb%20%3F", 2)

    Agent.update(agent, &%{&1 | status: 404})
    assert Marketplace.get("missing") == nil
    Agent.update(agent, &%{&1 | status: 503})
    assert_raise RuntimeError, "marketplace API returned 503", fn -> Marketplace.get("item_1") end
    assert length(Agent.get(agent, & &1.requests)) == 4
  end

  test "ordered alert readback is independent, session isolated and never reset by GET" do
    initial = build_conn() |> get("/marketplace/fr-FR/item_1")

    [token] =
      initial
      |> html_response(200)
      |> LazyHTML.from_document()
      |> LazyHTML.query("input[name=_csrf_token]")
      |> LazyHTML.attribute("value")

    assert initial |> recycle() |> get("/api/alerts") |> json_response(200) == []

    posted =
      initial
      |> recycle()
      |> post("/marketplace/fr-FR/item_1", %{
        "_csrf_token" => token,
        "email" => "first@example.test",
        "target_price" => "12,50"
      })

    assert html_response(posted, 200) =~ "first@example.test"

    posted =
      posted
      |> recycle()
      |> post("/marketplace/fr-FR/item_1", %{
        "_csrf_token" => token,
        "email" => "second@example.test",
        "target_price" => "0,105"
      })

    assert html_response(posted, 200) =~ "second@example.test"

    expected = [
      %{"item_id" => "item_1", "email" => "first@example.test", "target_minor" => 1250},
      %{"item_id" => "item_1", "email" => "second@example.test", "target_minor" => 11}
    ]

    for {email, target} <- [{"bad", "12,50"}, {"a@b", "NaN"}, {"a@b", "0"}, {"a@b", ""}] do
      assert posted
             |> recycle()
             |> post("/marketplace/fr-FR/item_1", %{
               "_csrf_token" => token,
               "email" => email,
               "target_price" => target
             })
             |> html_response(200)
    end

    for _ <- 1..2 do
      assert posted
             |> recycle()
             |> get("/api/alerts?email=fake&target_minor=999")
             |> json_response(200) == expected
    end

    assert build_conn() |> get("/api/alerts") |> json_response(200) == []

    assert posted
           |> recycle()
           |> Plug.Conn.put_req_header("sec-fetch-site", "cross-site")
           |> post("/marketplace/fr-FR/item_1", %{
             "_csrf_token" => token,
             "email" => "a@b",
             "target_price" => "12,50"
           })
           |> response(403)

    assert posted
           |> recycle()
           |> Plug.Conn.put_req_header("origin", "https://other.test")
           |> post("/marketplace/fr-FR/item_1", %{
             "_csrf_token" => token,
             "email" => "a@b",
             "target_price" => "12,50"
           })
           |> response(403)

    assert posted |> recycle() |> get("/api/alerts") |> json_response(200) == expected
  end

  test "native agent serializes concurrent appends without losing alerts" do
    session_id = Base.encode64(:crypto.strong_rand_bytes(32))

    1..80
    |> Task.async_stream(
      fn n ->
        ItemPage.MarketplaceAlerts.append(session_id, %{
          item_id: "item_1",
          email: "#{n}@test",
          target_minor: n
        })
      end, max_concurrency: 8)
    |> Enum.each(fn result -> assert {:ok, :ok} = result end)

    alerts = ItemPage.MarketplaceAlerts.list(session_id)
    assert length(alerts) == 80
    assert length(Enum.uniq_by(alerts, & &1.email)) == 80
    assert ItemPage.MarketplaceAlerts.list(nil) == []
  end
end
