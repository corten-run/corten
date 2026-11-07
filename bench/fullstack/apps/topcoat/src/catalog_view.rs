use std::sync::Arc;
use topcoat::{
    Result,
    context::Cx,
    router::{
        content::{Form, Json},
        error::not_found,
        href, page, path_param, route,
    },
    runtime::link,
    view::{View, ViewExt, view},
};

use crate::{Id, catalog, document, missing};

#[derive(serde::Deserialize)]
pub(crate) struct CatalogQuery {
    #[serde(default)]
    field: String,
}

#[page("/catalog/{id}")]
pub async fn catalog_page(cx: &Cx, Form(query): Form<CatalogQuery>) -> Result<impl View> {
    let Some(record) = catalog::source::get(path_param::<Id>(cx)).await.map_err(topcoat::Error::msg)? else {
        return Ok(view! { missing() }.boxed());
    };
    Ok(view! {
        document(
            title: format!("{} | Card Market", record.title),
            catalog: true,
            <article aria-label="Catalog record">
                <h1>(&record.title)</h1>
                <p>(&record.subtitle)</p>
                <p>(&record.description)</p>
                <ul aria-label="Tags">
                    for tag in &record.tags { <li>(tag)</li> }
                </ul>
                <form method="get" action=(href!(catalog_page, Id(record.id.as_str())))>
                    <label>"Field name " <input name="field" value=(&query.field)></label>
                    <button type="submit">"Filter"</button>
                </form>
                <table>
                    <caption>"Record fields"</caption>
                    <thead><tr><th scope="col">"Name"</th><th scope="col">"Value"</th></tr></thead>
                    <tbody>
                        for field in record.fields_with_prefix(&query.field) {
                            <tr><th scope="row">(&field.name)</th><td>(&field.value)</td></tr>
                        }
                    </tbody>
                </table>
                <nav aria-label="Related records">
                    <ul>
                        for related in &record.related {
                            <li>link(href: href!(catalog_page, Id(related.id.as_str())), (&related.title))</li>
                        }
                    </ul>
                </nav>
            </article>
        )
    }
    .boxed())
}

#[route(GET "/api/catalog/{id}")]
pub async fn catalog_json(cx: &Cx) -> Result<Json<Arc<catalog::Record>>> {
    let record = catalog::source::get(path_param::<Id>(cx)).await.map_err(topcoat::Error::msg)?.ok_or_else(not_found)?;
    Ok(Json(record))
}
