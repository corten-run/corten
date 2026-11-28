use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub name: String,
    pub slug: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub lowest_minor: Option<i64>,
    pub count: u64,
    pub quantity: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Offer {
    pub id: String,
    pub buyer: String,
    pub condition: String,
    pub quantity: u64,
    pub price_minor: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContentLine {
    pub id: String,
    pub item_id: String,
    pub title: String,
    pub quantity: u64,
}
