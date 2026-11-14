require "bigdecimal"
require "twitter_cldr"

class MarketplaceFormat
  LABELS = JSON.parse(File.read(Rails.root.join("config/marketplace_labels.json"))).freeze
  LOCALES = { "en-US" => :en, "fr-FR" => :fr, "de-DE" => :de }.freeze

  attr_reader :labels

  def initialize(locale)
    @locale = LOCALES.fetch(locale)
    @labels = LABELS.fetch(locale)
    @symbols = TwitterCldr::DataReaders::NumberDataReader.new(@locale).symbols
  end

  def money(minor)
    minor.nil? ? "\u2014" : amount(BigDecimal(minor) / 100)
  end

  def amount(value)
    value.round(2, BigDecimal::ROUND_HALF_UP).localize(@locale).to_currency.to_s(currency: "USD", precision: 2)
  end

  def number(value)
    value.localize(@locale).to_decimal.to_s(precision: 0)
  end

  def rating(hundredths)
    value = (BigDecimal(hundredths) / 100).round(1, BigDecimal::ROUND_HALF_UP)
    value.localize(@locale).to_decimal.to_s(precision: value.frac.zero? ? 0 : 1)
  end

  def count(value)
    category = value.localize(@locale).plural_rule
    "#{number(value)} #{@labels.fetch("listing_#{category}")}"
  end

  def alert(email, target, title)
    alert_result(email, target, title).first
  end

  def alert_result(email, target, title)
    return [@labels.fetch("invalid_email"), nil] unless email.include?("@")
    # Read the decimal separator from CLDR; grouping is optional in the contract.
    decimal = @symbols.fetch(:decimal)
    return [@labels.fetch("invalid_price"), nil] unless /\A[+-]?[0-9]+(?:#{Regexp.escape(decimal)}[0-9]+)?\z/.match?(target)
    value = BigDecimal(target.sub(decimal, "."))
    return [@labels.fetch("invalid_price"), nil] unless value.finite? && value.positive?
    message = @labels.fetch("alert_set").gsub(/\{email\}|\{title\}|\{price\}/,
      "{email}" => email, "{title}" => title, "{price}" => amount(value))
    [message, (value * 100).round(0, BigDecimal::ROUND_HALF_UP).to_i]
  end
end
