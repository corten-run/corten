defmodule ItemPageWeb.MarketplaceController do
  use ItemPageWeb, :controller
  alias ItemPage.{Marketplace, MarketplaceFormat, MarketplaceAlerts}
  plug :same_site_write

  def show(conn, %{"locale" => locale, "id" => id} = params) do
    if MarketplaceFormat.supported?(locale) do
      record = Marketplace.get(id) || raise ItemPageWeb.NotFound

      session_id =
        get_session(conn, :marketplace_alerts_id) ||
          Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

      conn = put_session(conn, :marketplace_alerts_id, session_id)
      prefix = Map.get(params, "seller", "")
      sort = if params["sort"] == "desc", do: "desc", else: "asc"
      all = params["offers"] == "all"

      message =
        if conn.method == "POST" do
          {message, minor} =
            MarketplaceFormat.alert_result(
              Map.get(params, "email", ""),
              Map.get(params, "target_price", ""),
              record["title"],
              locale
            )

          if minor != nil do
            MarketplaceAlerts.append(session_id, %{
              item_id: record["id"],
              email: params["email"],
              target_minor: minor
            })
          end

          message
        else
          ""
        end

      render(conn, :show,
        record: record,
        alert_session: session_id,
        email: if(is_binary(params["email"]), do: params["email"], else: ""),
        target: if(is_binary(params["target_price"]), do: params["target_price"], else: ""),
        locale: locale,
        marketplace_page: true,
        page_title: record["title"],
        t: MarketplaceFormat.labels(locale),
        prefix: prefix,
        sort: sort,
        all_offers: all,
        listings: Marketplace.listings(record, prefix, sort),
        offers: if(all, do: record["offers"], else: Enum.take(record["offers"], 5)),
        message: message
      )
    else
      send_resp(conn, :bad_request, "Unsupported locale")
    end
  end

  def json_record(conn, %{"id" => id}) do
    case Marketplace.get(id) do
      nil -> conn |> put_status(:not_found) |> json(%{error: "Not found"})
      record -> json(conn, record)
    end
  end

  def alerts(conn, _params) do
    conn
    |> put_resp_header("cache-control", "private, no-store")
    |> json(MarketplaceAlerts.list(get_session(conn, :marketplace_alerts_id)))
  end

  defp same_site_write(%{method: "POST"} = conn, _opts) do
    origin =
      "#{conn.scheme}://#{conn.host}" <> if(conn.port in [80, 443], do: "", else: ":#{conn.port}")

    if get_req_header(conn, "sec-fetch-site") == ["cross-site"] or
         Enum.any?(get_req_header(conn, "origin"), &(&1 != origin)) do
      conn |> send_resp(:forbidden, "Cross-site write rejected") |> halt()
    else
      conn
    end
  end

  defp same_site_write(conn, _opts), do: conn
end
