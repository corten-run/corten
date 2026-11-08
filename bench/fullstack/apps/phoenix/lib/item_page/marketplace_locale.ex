defmodule ItemPage.MarketplaceLocale do
  @config Cldr.Config.config_from_opts(
            backend: __MODULE__,
            locales: ["en", "fr", "de"],
            default_locale: "en"
          )
  Cldr.install_locales(@config)

  @currency_patterns [:en, :fr, :de]
                     |> Enum.map(fn locale ->
                       positive =
                         Cldr.Locale.Loader.get_locale(locale, @config).number_formats.latn.currency

                       positive <> ";-" <> positive
                     end)
                     |> Enum.uniq()

  use Cldr,
    locales: ["en", "fr", "de"],
    default_locale: "en",
    providers: [Cldr.Number],
    precompile_number_formats: ["#,##0.#" | @currency_patterns]
end
