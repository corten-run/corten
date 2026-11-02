defmodule ItemPageWeb.ErrorHTML do
  @moduledoc """
  Pages for errors on HTML requests (config/config.exs), in the root layout. A missing item gets
  Corten's not-found page; any other error the plain text Phoenix writes by default.
  """
  use ItemPageWeb, :html

  def render("404.html", assigns) do
    ~H"""
    <h1>Not found</h1>
    <p>There is no card at this address.</p>
    <p><a href="/">Go to popular items</a></p>
    """
  end

  def render(template, _assigns) do
    Phoenix.Controller.status_message_from_template(template)
  end
end
