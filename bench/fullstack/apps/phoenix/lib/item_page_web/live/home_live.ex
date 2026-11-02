defmodule ItemPageWeb.HomeLive do
  use ItemPageWeb, :live_view
  alias ItemPage.Items

  # Corten's home page: cards for the first 50 items with items in memory, links by id from the
  # item API (which cannot list items).
  def mount(_params, _session, socket), do: {:ok, assign(socket, page_title: "Popular items | Card Market", shelf: Items.shelf())}

  def render(assigns) do
    ~H"""
    <h1>Popular items</h1>
    <ul :if={@shelf != []} class="item-list__list">
      <li :for={item <- @shelf}>
        <.link navigate={~p"/items/#{item.id}"} class="item-card__card"><strong>{item.title}</strong><span :if={item.subtitle} class="item-card__set">{item.subtitle}</span><%= if s = item.summary do %><span class="item-card__from">From {s.lowest || "—"}</span><% else %><span class="item-card__from">No listings yet</span><% end %></.link>
      </li>
    </ul>
    <ul :if={@shelf == []} class="item-list__list item-list__ids">
      <li :for={n <- 1..50}><.link navigate={~p"/items/item_#{n}"}>Item {n}</.link></li>
    </ul>
    """
  end
end
