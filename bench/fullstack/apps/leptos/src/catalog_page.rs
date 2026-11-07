use leptos::prelude::*;
use leptos_meta::{Stylesheet, Title};
use leptos_router::{
    components::A,
    hooks::{use_params_map, use_query_map},
};

use crate::catalog::Record;
use std::sync::Arc;

#[server]
pub async fn load_record(id: String) -> Result<Option<Arc<Record>>, ServerFnError> {
    crate::catalog::source::get(&id).await.map_err(ServerFnError::new)
}

#[cfg(feature = "ssr")]
pub async fn catalog_json(axum::extract::Path(id): axum::extract::Path<String>) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse, Json};
    match crate::catalog::source::get(&id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => (StatusCode::BAD_GATEWAY, "The catalog API did not answer.").into_response(),
    }
}

#[component]
pub fn CatalogPage() -> impl IntoView {
    let params = use_params_map();
    let query = use_query_map();
    let record = Resource::new(
        move || (params.read().get("id").unwrap_or_default(), query.read().get("field").unwrap_or_default()),
        |(id, prefix)| async move { (load_record(id).await, prefix) },
    );
    view! {
        <Stylesheet href="/catalog.css"/>
        <Suspense fallback=|| ()>
            {move || Suspend::new(async move {
                let (result, prefix) = record.await;
                match result {
                    Ok(Some(record)) => view! { <CatalogDetail record prefix/> }.into_any(),
                    result => {
                        let missing = matches!(result, Ok(None));
                        #[cfg(feature = "ssr")]
                        if let Some(response) = use_context::<leptos_axum::ResponseOptions>() {
                            response.set_status(if missing {
                                axum::http::StatusCode::NOT_FOUND
                            } else {
                                axum::http::StatusCode::BAD_GATEWAY
                            });
                        }
                        let message = if missing { "Not found" } else { "The catalog API did not answer." };
                        view! { <Title text=message/><h1>{message}</h1> }.into_any()
                    }
                }
            })}
        </Suspense>
    }
}

#[component]
fn CatalogDetail(record: Arc<Record>, prefix: String) -> impl IntoView {
    let fields = record.fields_with_prefix(&prefix).cloned().collect::<Vec<_>>();
    view! {
        <Title text=format!("{} | Card Market", record.title)/>
        <article aria-label="Catalog record">
            <h1>{record.title.clone()}</h1>
            <p>{record.subtitle.clone()}</p>
            <p>{record.description.clone()}</p>
            <ul aria-label="Tags">
                {record.tags.iter().map(|tag| view! { <li>{tag.clone()}</li> }).collect_view()}
            </ul>
            <form method="get" action=format!("/catalog/{}", record.id)>
                <label>"Field name "<input name="field" value=prefix/></label>
                <button type="submit">"Filter"</button>
            </form>
            <table>
                <caption>"Record fields"</caption>
                <thead><tr><th scope="col">"Name"</th><th scope="col">"Value"</th></tr></thead>
                <tbody>
                    {fields.into_iter().map(|field| view! {
                        <tr><th scope="row">{field.name}</th><td>{field.value}</td></tr>
                    }).collect_view()}
                </tbody>
            </table>
            <nav aria-label="Related records">
                <ul>
                    {record.related.iter().cloned().map(|related| view! {
                        <li><A href=format!("/catalog/{}", related.id)>{related.title}</A></li>
                    }).collect_view()}
                </ul>
            </nav>
        </article>
    }
}
