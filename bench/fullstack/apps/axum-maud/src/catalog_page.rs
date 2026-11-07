use maud::{Markup, html};

pub fn render(record: &crate::catalog::Record, prefix: &str) -> Markup {
    crate::pages::document(
        &format!("{} | Card Market", record.title),
        html! {
            article aria-label="Catalog record" {
                h1 { (record.title) }
                p { (record.subtitle) }
                p { (record.description) }
                ul aria-label="Tags" {
                    @for tag in &record.tags { li { (tag) } }
                }
                form method="get" action={ "/catalog/" (record.id) } {
                    label { "Field name " input name="field" value=(prefix); }
                    button type="submit" { "Filter" }
                }
                table {
                    caption { "Record fields" }
                    thead { tr { th scope="col" { "Name" } th scope="col" { "Value" } } }
                    tbody {
                        @for field in record.fields_with_prefix(prefix) {
                            tr { th scope="row" { (field.name) } td { (field.value) } }
                        }
                    }
                }
                nav aria-label="Related records" {
                    ul {
                        @for related in &record.related {
                            li { a href={ "/catalog/" (related.id) } { (related.title) } }
                        }
                    }
                }
            }
        },
        true,
    )
}
