use crate::{CatalogQuery, routes, source::Record};
use corten::prelude::*;
mod site_header;
pub use site_header::SiteHeader;

corten::assets::embed! {
    pub struct Static = "static";
}

#[component]
pub fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>{title}" | Card Market"</title>
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <link rel="stylesheet" href={req.asset(Static::SHELL_CSS)}>
                <link rel="stylesheet" href={req.asset(Static::CATALOG_CSS)}>
                <Corten />
            </head>
            <body>
                <SiteHeader />
                <main>{children}</main>
            </body>
        </html>
    }
}

pub fn document<'a>(req: &'a Req, title: &'a str, children: impl Render + 'a) -> impl Document + 'a {
    html! { <Layout req={req} title={title}>{children}</Layout> }
}

pub fn record<'a>(record: &'a Record, prefix: &'a str) -> impl Render + 'a {
    let fields = CatalogQuery::FIELDS;
    html! {
        <article aria-label="Catalog record">
            <h1>{&record.title}</h1>
            <p>{&record.subtitle}</p>
            <p>{&record.description}</p>
            <ul aria-label="Tags">for tag in &record.tags { <li>{tag}</li> }</ul>
            <form method="get" action={routes::Catalog { id: &record.id, query: CatalogQuery::default() }}>
                <label>"Field name "<input name={fields.field} value={prefix}></label>
                <button type="submit">"Filter"</button>
            </form>
            <table>
                <caption>"Record fields"</caption>
                <thead><tr><th scope="col">"Name"</th><th scope="col">"Value"</th></tr></thead>
                <tbody>
                    for field in record.fields.iter().filter(|field| field.name.starts_with(prefix)) {
                        <tr><th scope="row">{&field.name}</th><td>{&field.value}</td></tr>
                    }
                </tbody>
            </table>
            <nav aria-label="Related records">
                <ul>
                    for related in &record.related {
                        <li><a href={routes::Catalog { id: &related.id, query: CatalogQuery::default() }}>{&related.title}</a></li>
                    }
                </ul>
            </nav>
        </article>
    }
}
