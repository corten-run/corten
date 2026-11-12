defmodule ItemPage.MarketplaceFormat do
  alias ItemPage.MarketplaceLocale, as: Locale
  @external_resource Path.expand("../../priv/marketplace-labels.json", __DIR__)
  @labels @external_resource |> File.read!() |> Jason.decode!()

  def supported?(locale), do: Map.has_key?(@labels, locale)
  def labels(locale), do: Map.fetch!(@labels, locale)
  def money(nil, _locale), do: "—"
  def money(minor, locale), do: amount(Decimal.div(Decimal.new(minor), Decimal.new(100)), locale)

  def amount(value, locale) do
    {:ok, formats} = Locale.Number.Format.formats_for(locale)
    # ex_cldr_numbers 2.38.3 puts an implicit negative sign after a currency
    # prefix. Keep CLDR's currency pattern and make its standard negative
    # subpattern explicit so the native formatter places the sign correctly.
    pattern = formats.currency <> ";-" <> formats.currency

    Locale.Number.to_string!(value,
      locale: locale,
      currency: :USD,
      format: pattern,
      rounding_mode: :half_up
    )
  end

  def count(value, locale),
    do: Locale.Number.to_string!(value, locale: locale, fractional_digits: 0)

  def rating(value, locale) do
    Decimal.new(value)
    |> Decimal.div(Decimal.new(100))
    |> Locale.Number.to_string!(locale: locale, format: "#,##0.#", rounding_mode: :half_up)
  end

  def listings(value, locale) do
    category = Locale.Number.Cardinal.plural_rule(value, locale)
    count(value, locale) <> " " <> labels(locale)["listing_#{category}"]
  end

  def alert(email, target, title, locale) do
    {message, _minor} = alert_result(email, target, title, locale)
    message
  end

  def alert_result(email, target, title, locale) when is_binary(email) and is_binary(target) do
    text = labels(locale)

    if String.contains?(email, "@") do
      case Locale.Number.parse(String.trim(target), locale: locale, number: :decimal) do
        {:ok, %Decimal{coef: coefficient} = value} when is_integer(coefficient) ->
          if Decimal.compare(value, Decimal.new(0)) == :gt do
            values = %{"email" => email, "title" => title, "price" => amount(value, locale)}

            message =
              Regex.replace(~r/\{(email|title|price)\}/, text["alert_set"], fn _, key ->
                Map.fetch!(values, key)
              end)

            minor =
              value |> Decimal.mult(100) |> Decimal.round(0, :half_up) |> Decimal.to_integer()

            {message, minor}
          else
            {text["invalid_price"], nil}
          end

        _ ->
          {text["invalid_price"], nil}
      end
    else
      {text["invalid_email"], nil}
    end
  end

  def alert_result(_email, _target, _title, locale), do: {labels(locale)["invalid_price"], nil}
end
