defmodule ItemPage.Catalog do
  defmodule Field do
    @derive Jason.Encoder
    @enforce_keys [:name, :value]
    defstruct [:name, :value]
    @type t :: %__MODULE__{name: String.t(), value: String.t()}
  end

  defmodule Related do
    @derive Jason.Encoder
    @enforce_keys [:id, :title]
    defstruct [:id, :title]
    @type t :: %__MODULE__{id: String.t(), title: String.t()}
  end

  defmodule Record do
    @derive Jason.Encoder
    @enforce_keys [:id, :title, :subtitle, :description, :tags, :fields, :related]
    defstruct @enforce_keys
    @type t :: %__MODULE__{
      id: String.t(), title: String.t(), subtitle: String.t(), description: String.t(),
      tags: [String.t()], fields: [Field.t()], related: [Related.t()]
    }
  end

  def load_fixture do
    if System.get_env("CATALOG_SOURCE") == "fixture" do
      records = System.get_env("CATALOG_FIXTURE_PATH", "/fixtures/catalog.json")
      |> File.read!()
      |> Jason.decode!()
      |> Map.new(fn {id, record} -> {id, from_json(record)} end)
      :persistent_term.put(__MODULE__, records)
    end
    :ok
  end

  @spec get(String.t()) :: Record.t() | nil
  def get(id) do
    case :persistent_term.get(__MODULE__, nil) do
      nil -> fetch(id)
      records -> Map.get(records, id)
    end
  end

  defp fetch(id) do
    base = System.get_env("API_BASE", "http://localhost:8080")
    # Decode explicitly once, regardless of the upstream Content-Type.
    case Req.get!(base <> "/catalog/records/" <> URI.encode(id, &URI.char_unreserved?/1),
           retry: false, redirect: false, decode_body: false, finch: [name: ItemPage.Finch]) do
      %{status: 404} -> nil
      %{status: 200, body: body} -> body |> Jason.decode!() |> from_json()
      %{status: status} -> raise "catalog API returned #{status}"
    end
  end

  defp text(value) when is_binary(value), do: value
  defp text(_), do: raise(ArgumentError, "catalog values must be strings")
  defp array(value) when is_list(value), do: value
  defp array(_), do: raise(ArgumentError, "catalog arrays are required")

  defp from_json(a) do
    %Record{
      id: text(a["id"]), title: text(a["title"]), subtitle: text(a["subtitle"]),
      description: text(a["description"]), tags: Enum.map(array(a["tags"]), &text/1),
      fields: Enum.map(array(a["fields"]), fn f -> %Field{name: text(f["name"]), value: text(f["value"])} end),
      related: Enum.map(array(a["related"]), fn r -> %Related{id: text(r["id"]), title: text(r["title"])} end)
    }
  end
end
