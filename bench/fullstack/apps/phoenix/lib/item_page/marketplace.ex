defmodule ItemPage.Marketplace do
  @keys ~w(id title subtitle description categories badges tags images fields summary listings offers contents included_in)
  @category ~w(name slug)
  @field ~w(name value)
  @summary ~w(lowest_minor count quantity)
  @listing ~w(id seller rating_hundredths reviews condition ships_from quantity price_minor)
  @offer ~w(id buyer condition quantity price_minor)
  @line ~w(id item_id title quantity)

  def load_fixture do
    if System.get_env("MARKETPLACE_SOURCE") == "fixture" do
      records =
        System.get_env("MARKETPLACE_FIXTURE_PATH", "/fixtures/marketplace.json")
        |> File.read!()
        |> Jason.decode!()
        |> Map.new(fn {id, record} -> {id, from_json(record)} end)

      :persistent_term.put(__MODULE__, records)
    end

    :ok
  end

  def get(id) do
    case :persistent_term.get(__MODULE__, nil) do
      nil -> fetch(id)
      records -> Map.get(records, id)
    end
  end

  defp fetch(id) do
    base = System.get_env("API_BASE", "http://localhost:8080")

    case Req.get!(base <> "/marketplace/records/" <> URI.encode(id, &URI.char_unreserved?/1),
           retry: false,
           redirect: false,
           decode_body: false,
           finch: [name: ItemPage.Finch]
         ) do
      %{status: 404} -> nil
      %{status: 200, body: body} -> body |> Jason.decode!() |> from_json()
      %{status: status} -> raise "marketplace API returned #{status}"
    end
  end

  # Construct the response's complete numeric shape instead of relaying upstream JSON.
  def from_json(record) do
    record = required(record, @keys)

    record
    |> Map.update!("categories", &Enum.map(&1, fn row -> required(row, @category) end))
    |> Map.update!("fields", &Enum.map(&1, fn row -> required(row, @field) end))
    |> Map.update!("summary", fn row -> if row, do: required(row, @summary), else: nil end)
    |> Map.update!("listings", &Enum.map(&1, fn row -> required(row, @listing) end))
    |> Map.update!("offers", &Enum.map(&1, fn row -> required(row, @offer) end))
    |> Map.update!("contents", &Enum.map(&1, fn row -> required(row, @line) end))
    |> Map.update!("included_in", &Enum.map(&1, fn row -> required(row, @line) end))
  end

  defp required(record, keys), do: Map.new(keys, &{&1, Map.fetch!(record, &1)})

  def listings(record, prefix, sort) do
    record["listings"]
    |> Enum.filter(&String.starts_with?(&1["seller"], prefix))
    |> Enum.sort_by(fn row ->
      price = row["price_minor"]
      {is_nil(price), if(is_nil(price), do: 0, else: if(sort == "desc", do: -price, else: price))}
    end)
  end
end
