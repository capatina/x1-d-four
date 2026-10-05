//! HTTP + WebSocket server (protocol in docs/protocol.md) and the embedded UI.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde_json::{Value, json};

use crate::app::{App, ClientCommand};

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
#[allow_missing = true]
struct Assets;

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/ws", get(ws))
        .route("/api/library", get(library))
        .route("/api/library/rescan", post(rescan))
        .route("/api/state", get(|State(app): State<Arc<App>>| async move { Json(app.state_json()) }))
        .route("/api/decks", get(|State(app): State<Arc<App>>| async move { Json(app.decks_json()) }))
        .route("/api/midi/recent", get(|State(app): State<Arc<App>>| async move { Json(app.midi_recent()) }))
        .route("/api/controls", get(|State(app): State<Arc<App>>| async move { Json(app.controls_json()) }))
        .route("/api/mappings", get(|State(app): State<Arc<App>>| async move { Json(app.mappings_json()) }))
        .route("/api/command", post(command))
        .fallback(static_file)
        .with_state(app)
}

async fn library(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!(app.library.read().unwrap().tracks))
}

async fn rescan(State(app): State<Arc<App>>) -> Json<Value> {
    let a = app.clone();
    tokio::task::spawn_blocking(move || a.rescan()).await.ok();
    Json(json!({ "tracks": app.library.read().unwrap().tracks.len() }))
}

async fn command(State(app): State<Arc<App>>, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    match serde_json::from_value::<ClientCommand>(body) {
        Ok(cmd) => match app.command(cmd) {
            Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
            Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
        },
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e.to_string() }))),
    }
}

async fn ws(State(app): State<Arc<App>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| client(app, socket))
}

async fn client(app: Arc<App>, socket: WebSocket) {
    let (mut tx, mut rx) = socket.split();
    let mut feed = app.tx.subscribe();
    for msg in app.hello() {
        if tx.send(Message::text(msg.to_string())).await.is_err() {
            return;
        }
    }
    let send = async {
        loop {
            match feed.recv().await {
                Ok(msg) => {
                    if tx.send(Message::text(msg.to_string())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::debug!(skipped = n, "slow websocket client");
                }
                Err(_) => break,
            }
        }
    };
    let recv = async {
        while let Some(Ok(msg)) = rx.next().await {
            let Message::Text(text) = msg else { continue };
            match serde_json::from_str::<ClientCommand>(&text) {
                Ok(cmd) => {
                    if let Err(e) = app.command(cmd) {
                        let _ = app.tx.send(Arc::from(json!({ "type": "error", "message": e }).to_string()));
                    }
                }
                Err(e) => tracing::warn!(error = %e, %text, "bad command"),
            }
        }
    };
    tokio::select! {
        _ = send => {}
        _ = recv => {}
    }
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (path, file) = match Assets::get(path) {
        Some(f) if !path.is_empty() => (path, f),
        _ => match Assets::get("index.html") {
            Some(f) => ("index.html", f),
            None => {
                return (StatusCode::NOT_FOUND, "UI not built: run `bun run build` in ui/ and rebuild").into_response();
            }
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    ([(header::CONTENT_TYPE, mime.as_ref().to_owned())], file.data).into_response()
}
