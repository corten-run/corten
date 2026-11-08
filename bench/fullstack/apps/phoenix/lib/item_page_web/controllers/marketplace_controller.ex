defmodule ItemPageWeb.MarketplaceController do
  use ItemPageWeb, :controller
  alias ItemPage.{Marketplace, MarketplaceFormat}

  def show(conn, %{"locale" => locale, "id" => id} = params) do
    if MarketplaceFormat.supported?(locale) do
      record = Marketplace.get(id) || raise ItemPageWeb.NotFound
      prefix = Map.get(params, "seller", "")
      sort = if params["sort"] == "desc", do: "desc", else: "asc"
      all = params["offers"] == "all"

      message =
        if conn.method == "POST",
          do:
            MarketplaceFormat.alert(
              Map.get(params, "email", ""),
              Map.get(params, "target_price", ""),
              record["title"],
              locale
            ),
          else: ""

      render(conn, :show,
        record: record,
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
end
