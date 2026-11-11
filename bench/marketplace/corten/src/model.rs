use serde::Serialize;
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct Record {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: String,
    pub categories: Vec<Category>,
    pub badges: Vec<String>,
    pub tags: Vec<String>,
    pub images: Vec<String>,
    pub fields: Vec<Field>,
    pub summary: Option<Summary>,
    pub listings: Vec<Listing>,
    pub offers: Vec<Offer>,
    pub contents: Vec<ContentLine>,
    pub included_in: Vec<ContentLine>,
}
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct Category {
    pub name: String,
    pub slug: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct Field {
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct Summary {
    pub lowest_minor: Option<i64>,
    pub count: u64,
    pub quantity: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct Listing {
    pub id: String,
    pub seller: String,
    pub rating_hundredths: Option<u16>,
    pub reviews: u64,
    pub condition: String,
    pub ships_from: String,
    pub quantity: u64,
    pub price_minor: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct Offer {
    pub id: String,
    pub buyer: String,
    pub condition: String,
    pub quantity: u64,
    pub price_minor: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, corten::FromJson, corten::ToJson)]
pub struct ContentLine {
    pub id: String,
    pub item_id: String,
    pub title: String,
    pub quantity: u64,
}

impl Record {
    pub fn listings(&self, query: &crate::MarketplaceQuery) -> Vec<&Listing> {
        let prefix = query.seller.as_deref().unwrap_or_default();
        let mut rows: Vec<_> = self.listings.iter().filter(|row| row.seller.starts_with(prefix)).collect();
        rows.sort_by(|a, b| match (a.price_minor, b.price_minor) {
            (Some(a), Some(b)) if query.descending() => b.cmp(&a),
            (Some(a), Some(b)) => a.cmp(&b),
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, None) => std::cmp::Ordering::Equal,
        });
        rows
    }
}
