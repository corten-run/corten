//! Downstream trait resolution with Corten's real response trait in scope.

use corten::http::{IntoResponse, Response, StatusCode};

trait AppCache {
    fn may_share() -> bool;
}

struct Reply;

impl AppCache for Reply {
    fn may_share() -> bool {
        true
    }
}

impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        StatusCode::ACCEPTED.into_response()
    }
}

#[test]
fn app_may_share_stays_unambiguous_with_into_response_in_scope() {
    assert!(Reply::may_share());
    assert_eq!(Reply.into_response().status(), StatusCode::ACCEPTED);
}
