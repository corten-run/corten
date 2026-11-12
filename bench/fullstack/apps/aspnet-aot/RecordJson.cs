using System.Text.Json.Serialization;

namespace ItemJson;

// Catalog's single-word keys and marketplace's numeric snake_case schema. Every constructor
// parameter is required, including nullable fields; unknown upstream fields are not forwarded.
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower,
    RespectNullableAnnotations = true, RespectRequiredConstructorParameters = true)]
[JsonSerializable(typeof(Dictionary<string, CatalogRecord>))]
[JsonSerializable(typeof(CatalogRecord))]
[JsonSerializable(typeof(Dictionary<string, MarketplaceRecord>))]
[JsonSerializable(typeof(MarketplaceRecord))]
public partial class RecordJson : JsonSerializerContext;
