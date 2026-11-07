class CatalogRecord < Data.define(:id, :title, :subtitle, :description, :tags, :fields, :related)
  Field = Data.define(:name, :value)
  Related = Data.define(:id, :title)
  TEXT_KEYS = %w[id title subtitle description].freeze

  def self.strings(value, keys)
    unless value.is_a?(Hash) && value.keys.sort == keys.sort && keys.all? { |key| value[key].is_a?(String) }
      raise ArgumentError, "Invalid catalog text object"
    end
    value.transform_keys(&:to_sym)
  end

  def self.from_json(value)
    keys = TEXT_KEYS + %w[tags fields related]
    unless value.is_a?(Hash) && value.keys.sort == keys.sort &&
        %w[tags fields related].all? { |key| value[key].is_a?(Array) } &&
        value["tags"].all? { |tag| tag.is_a?(String) }
      raise ArgumentError, "Invalid catalog record"
    end
    new(**strings(value.slice(*TEXT_KEYS), TEXT_KEYS),
      tags: value["tags"],
      fields: value["fields"].map { |field| Field.new(**strings(field, %w[name value])) },
      related: value["related"].map { |row| Related.new(**strings(row, %w[id title])) })
  end

  def as_json(*)
    to_h.merge(fields: fields.map(&:to_h), related: related.map(&:to_h))
  end
end
