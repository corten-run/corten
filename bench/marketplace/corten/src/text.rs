use corten::i18n::{Currency, Decimal, Formatted, Minor};
corten::i18n::messages! {
    pub struct Msg {
        "en-US" => "locales/en-US.json",
        "fr-FR" => "locales/fr-FR.json",
        "de-DE" => "locales/de-DE.json",
    }
}
pub const USD: Currency = Currency::new("USD");
pub fn money(t: Msg, minor: Option<i64>) -> String {
    minor.map_or_else(|| "\u{2014}".into(), |minor| t.money(Minor(minor), USD).to_string())
}
pub fn rating(t: Msg, hundredths: u16) -> Formatted {
    let tenths = (hundredths + 5) / 10;
    t.number(if tenths.is_multiple_of(10) {
        Decimal::new(i128::from(tenths / 10), 0)
    } else {
        Decimal::new(i128::from(tenths), 1)
    })
}
pub fn alert(t: Msg, record: &crate::model::Record, form: &crate::AlertForm) -> Result<(String, u64), String> {
    if !form.email.contains('@') {
        return Err(t.invalid_email().into());
    }
    let Some(price) = t.parse_money(&form.target_price, USD).filter(|price| price.0 > 0) else {
        return Err(t.invalid_price().into());
    };
    Ok((t.alert_set(msg::AlertSet { email: &form.email, title: &record.title, price: t.money(price, USD) }).to_string(), price.0))
}
