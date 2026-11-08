defmodule ItemPageWeb.MarketplaceHTML do
  use ItemPageWeb, :html
  alias ItemPage.MarketplaceFormat, as: F
  embed_templates("marketplace_html/*")
end
