//! `balader serve`: the real core over HTTP, for testing the UI in a normal
//! browser (and Playwright) against real downloads.
//!
//!   POST /api/invoke/{cmd}   body = JSON args   → 200 value | 4xx/5xx {"error": ErrorPayload}
//!   GET  /api/events?token=  → Server-Sent Events, one CoreEvent JSON per message
//!   GET  /api/health         → {"ok":true}
//!
//! Bound to 127.0.0.1, token-protected, and CORS limited to the dev origins,
//! so a random web page can't drive it.

use std::collections::hash_map::RandomState;
use std::convert::Infallible;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use balader_core::{Core, ErrorCode, ErrorPayload};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct AppState {
    core: Arc<Core>,
    token: String,
}

fn random_token() -> String {
    let a = RandomState::new().build_hasher().finish();
    let mut h = RandomState::new().build_hasher();
    h.write_u64(a ^ std::process::id() as u64);
    format!("{a:016x}{:016x}", h.finish())
}

fn authorized(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let header_token = headers.get("x-balader-token").and_then(|v| v.to_str().ok());
    header_token.or(query_token) == Some(state.token.as_str())
}

fn deny() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": ErrorPayload { code: ErrorCode::BadRequest, message: "missing or wrong token".into(), hint: None, detail: None } })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn invoke(State(st): State<AppState>, Path(cmd): Path<String>, headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    if !authorized(&st, &headers, None) {
        return deny();
    }
    let args = body.map(|Json(v)| v).unwrap_or(Value::Null);
    match st.core.dispatch(&cmd, args).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            let status = match e.code {
                ErrorCode::BadRequest | ErrorCode::InvalidUrl => StatusCode::BAD_REQUEST,
                ErrorCode::NotFound => StatusCode::NOT_FOUND,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            (status, Json(json!({ "error": e }))).into_response()
        }
    }
}

async fn events(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<TokenQuery>) -> Response {
    if !authorized(&st, &headers, q.token.as_deref()) {
        return deny();
    }
    let rx = st.core.subscribe();
    let s: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> = Box::pin(stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    }));
    Sse::new(s).keep_alive(KeepAlive::new().interval(Duration::from_secs(10))).into_response()
}

pub async fn serve(core: Arc<Core>, port: u16, token: Option<String>, extra_origins: Vec<String>) {
    let token = token.unwrap_or_else(random_token);
    let mut origins: Vec<HeaderValue> =
        ["http://localhost:1420", "http://127.0.0.1:1420"].iter().map(|o| HeaderValue::from_static(o)).collect();
    for o in &extra_origins {
        if let Ok(v) = HeaderValue::from_str(o) {
            origins.push(v);
        }
    }
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::HeaderName::from_static("x-balader-token")]);
    let state = AppState { core, token: token.clone() };
    let app = Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/invoke/{cmd}", post(invoke))
        .route("/api/events", get(events))
        .layer(cors)
        .with_state(state);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("✗ can't listen on {addr}: {e}");
            return;
        }
    };
    // One line, easy to grep from scripts and tests.
    println!("BALADER_SERVE http://{addr} token={token}");
    println!("  UI against the real engine: http://localhost:1420/?backend=http&api=http://{addr}&token={token}");
    let _ = axum::serve(listener, app).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    }).await;
}
