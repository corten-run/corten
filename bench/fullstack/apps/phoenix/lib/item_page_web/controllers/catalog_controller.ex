defmodule ItemPageWeb.CatalogController do
  use ItemPageWeb, :controller

  def show(conn, %{"id" => id} = params) do
    record = ItemPage.Catalog.get(id) || raise ItemPageWeb.NotFound
    prefix = Map.get(params, "field", "")
    fields = Enum.filter(record.fields, &String.starts_with?(&1.name, prefix))
    render(conn, :show, record: record, fields: fields, prefix: prefix,
      page_title: record.title, catalog_page: true)
  end

  def json_record(conn, %{"id" => id}) do
    case ItemPage.Catalog.get(id) do
      nil -> conn |> put_status(:not_found) |> json(%{error: "Not found"})
      record -> json(conn, record)
    end
  end
end
