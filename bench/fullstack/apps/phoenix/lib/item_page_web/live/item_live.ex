defmodule ItemPageWeb.ItemLive do
  @moduledoc "The item page: rendered on the server, then the sort, \"show all\" and the price alert run as server events."
  use ItemPageWeb, :live_view
  alias ItemPage.Items

  def mount(%{"id" => id} = params, _session, socket) do
    item = Items.get(id) || raise ItemPageWeb.NotFound

    {:ok,
     assign(socket,
       item: item,
       page_title: "#{item.title} | Card Market",
       listings: Items.sort_listings(item.listings, false),
       descending: false,
       # "Show all" without JavaScript loads the page with ?offers=all.
       all_offers: params["offers"] == "all",
       message: ""
     )}
  end

  def handle_event("sort", _params, socket) do
    descending = not socket.assigns.descending
    {:noreply, assign(socket, descending: descending, listings: Items.sort_listings(socket.assigns.item.listings, descending))}
  end

  def handle_event("all_offers", _params, socket), do: {:noreply, assign(socket, all_offers: true)}

  def handle_event("alert", params, socket) do
    message = Items.alert_message(socket.assigns.item.title, params["email"] || "", params["target_price"] || "")
    {:noreply, assign(socket, message: message)}
  end

  def render(assigns) do
    ~H"""
    <article>
      <div class="item-detail__top">
        <div class="item-detail__intro">
          <nav class="item-detail__crumbs"><a :for={c <- @item.categories} href={"/categories/#{c.slug}"}>{c.name}</a></nav>
          <h1>{@item.title}</h1>
          <p :if={@item.subtitle} class="item-detail__subtitle">{@item.subtitle}</p>
          <ul class="item-detail__chips"><li :for={b <- @item.badges}>{b}</li></ul>
        </div>
        <div :if={@item.images != []} class="item-detail__gallery">
          <div :for={{url, i} <- Enum.with_index(@item.images, 1)} class="item-detail__image" role="img" aria-label={"#{@item.title} image #{i}"} data-src={url}></div>
        </div>
        <section class="item-detail__panel item-detail__summary gap-3 sm:gap-5">
          <%= if s = @item.summary do %>
            <span><strong>{s.lowest || "—"}</strong> lowest</span><span>{counted(s.count, "listing", "listings")}</span><span>{counted(s.quantity, "available", "available")}</span>
          <% else %>
            <span>No listings yet</span>
          <% end %>
        </section>
      </div>
      <section class="item-detail__panel">
        <h2>Listings</h2>
        <button type="button" phx-click="sort"><span hidden={@descending}>Price: low to high</span><span hidden={not @descending}>Price: high to low</span></button>
        <table>
          <thead><tr><th>Seller</th><th>Condition</th><th>Ships from</th><th>Qty</th><th>Price</th></tr></thead>
          <tbody>
            <tr :for={l <- @listings} id={"l-#{l.id}"}>
              <td>{l.seller}{if l.rating, do: " · #{l.rating} ★ (#{l.reviews})"}</td>
              <td>{l.condition}</td><td>{l.ships_from}</td><td>{l.quantity}</td><td class="price__amount">{l.price}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <section class="item-detail__panel">
        <h2>Offers</h2>
        <table>
          <thead><tr><th>Buyer</th><th>Condition</th><th>Qty</th><th>Price</th></tr></thead>
          <tbody>
            <tr :for={o <- if(@all_offers, do: @item.offers, else: Enum.take(@item.offers, 5))}>
              <td>{o.buyer}</td><td>{o.condition}</td><td>{o.quantity}</td><td class="price__amount">{o.price}</td>
            </tr>
          </tbody>
        </table>
        <form :if={length(@item.offers) > 5 and not @all_offers} method="get" action={"/items/#{@item.id}"} phx-submit="all_offers"><button name="offers" value="all">Show all {length(@item.offers)} offers</button></form>
      </section>
      <section class="item-detail__panel">
        <h2>Price alert</h2>
        <div class="alert-form__form">
          <form method="post" phx-submit="alert">
            <input type="hidden" name="item_id" value={@item.id} /><input type="hidden" name="title" value={@item.title} />
            <label>Email<input type="email" name="email" required /></label>
            <label>Alert me below<input type="text" name="target_price" inputmode="decimal" required /></label>
            <button type="submit">Set alert</button>
          </form>
        </div>
        <p class="alert-form__message" id="alert-message" aria-live="polite">{@message}</p>
      </section>
      <section class="item-detail__panel">
        <h2>Details</h2>
        <p>{@item.description}</p>
        <dl><%= for f <- @item.fields do %><dt>{f.name}</dt><dd>{f.value}</dd><% end %></dl>
        <ul :if={@item.tags != []} class="item-detail__chips"><li :for={t <- @item.tags}>{t}</li></ul>
      </section>
      <section :if={@item.contents != []} class="item-detail__panel">
        <h2>Contents</h2>
        <ul><li :for={c <- @item.contents}><.link navigate={~p"/items/#{c.item_id}"}>{c.title}</.link> × {c.quantity}</li></ul>
      </section>
      <section :if={@item.included_in != []} class="item-detail__panel">
        <h2>Included in</h2>
        <ul><li :for={c <- @item.included_in}><.link navigate={~p"/items/#{c.item_id}"}>{c.title}</.link> × {c.quantity}</li></ul>
      </section>
    </article>
    """
  end

  # A count as an English page writes it: digits grouped, and the word singular for one.
  defp counted(n, one, other) do
    digits =
      n
      |> abs()
      |> Integer.to_string()
      |> String.reverse()
      |> String.graphemes()
      |> Enum.chunk_every(3)
      |> Enum.map_join(",", &Enum.join/1)
      |> String.reverse()

    sign = if n < 0, do: "-", else: ""
    "#{sign}#{digits} #{if n == 1, do: one, else: other}"
  end
end
