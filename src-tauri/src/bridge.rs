//! Dev bridge (debug builds only): lets a test script or an AI agent drive
//! the *real* running app from the terminal.
//!
//! On start it listens on 127.0.0.1:<random port> and writes
//! `<app data dir>/dev-bridge.json` = {"port", "token", "pid"}.
//! Every request needs the token (`x-balader-token` header or `?token=`).
//!
//!   GET  /health          → {"ok":true,"pid":…}
//!   POST /eval            body = JS function body (use `return`) → {"ok":true,"value":…}
//!   GET  /state           → window.__balader.snapshot()
//!   GET  /events?n=50     → last core events seen by the shell
//!   GET  /snapshot        → PNG of the webview (macOS, WKWebView.takeSnapshot)
//!   POST /reload          → reloads the webview
//!
//! `scripts/bridge.mjs` wraps all of this: `npm run bridge -- eval "return document.title"`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, mpsc};
use std::time::Duration;

use balader_core::CoreEvent;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

type Pending = Mutex<HashMap<u64, mpsc::Sender<(bool, String)>>>;
static PENDING: LazyLock<Pending> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT: AtomicU64 = AtomicU64::new(1);
static EVENTS: LazyLock<Mutex<VecDeque<Value>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

pub fn record_event(ev: &CoreEvent) {
    if let Ok(v) = serde_json::to_value(ev) {
        let mut q = EVENTS.lock().unwrap();
        q.push_back(v);
        while q.len() > 400 {
            q.pop_front();
        }
    }
}

/// Results of `/eval` come back through this command.
#[tauri::command]
pub fn bridge_result(id: u64, ok: bool, value: String) {
    if let Some(tx) = PENDING.lock().unwrap().remove(&id) {
        let _ = tx.send((ok, value));
    }
}

fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let a = std::collections::hash_map::RandomState::new().build_hasher().finish();
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(a ^ u64::from(std::process::id()));
    format!("{a:016x}{:016x}", h.finish())
}

fn eval_js(app: &AppHandle, body: &str, timeout: Duration) -> Result<Value, String> {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    PENDING.lock().unwrap().insert(id, tx);
    let wrapped = format!(
        r#"(async () => {{
  const send = (ok, value) => window.__TAURI_INTERNALS__.invoke('bridge_result', {{ id: {id}, ok, value }});
  try {{
    const r = await (async () => {{ {body}
    }})();
    send(true, JSON.stringify(r === undefined ? null : r));
  }} catch (e) {{
    send(false, String((e && e.stack) || e));
  }}
}})();"#
    );
    let window = app.get_webview_window("main").ok_or("no main window")?;
    window.eval(&wrapped).map_err(|e| e.to_string())?;
    match rx.recv_timeout(timeout) {
        Ok((true, v)) => Ok(serde_json::from_str(&v).unwrap_or(Value::String(v))),
        Ok((false, e)) => Err(e),
        Err(_) => {
            PENDING.lock().unwrap().remove(&id);
            Err("timed out waiting for the page".into())
        }
    }
}

#[cfg(target_os = "macos")]
fn snapshot(app: &AppHandle) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let window = app.get_webview_window("main").ok_or("no main window")?;
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |pw| {
            let tx = tx.clone();
            let block = RcBlock::new(move |image: *mut NSImage, _err: *mut NSError| {
                let result = (|| {
                    // SAFETY: WebKit hands us a valid NSImage (or null) for the duration of the call.
                    let image = unsafe { image.as_ref() }.ok_or("snapshot returned no image")?;
                    let tiff = image.TIFFRepresentation().ok_or("no TIFF data")?;
                    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("no bitmap rep")?;
                    let props = NSDictionary::new();
                    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }.ok_or("PNG encoding failed")?;
                    Ok::<Vec<u8>, &str>(png.to_vec())
                })();
                let _ = tx.send(result.map_err(String::from));
            });
            // SAFETY: inner() is the WKWebView this webview wraps; we're on the main thread.
            unsafe {
                let wk: &WKWebView = &*(pw.inner() as *const WKWebView);
                wk.takeSnapshotWithConfiguration_completionHandler(None, &block);
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "snapshot timed out".to_string())?
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_app: &AppHandle) -> Result<Vec<u8>, String> {
    Err("snapshots are only implemented on macOS for now".into())
}

fn respond_json(req: tiny_http::Request, status: u16, v: Value) {
    let body = serde_json::to_vec(&v).unwrap_or_default();
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = req.respond(tiny_http::Response::from_data(body).with_status_code(status).with_header(header));
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:0") {
            Ok(s) => s,
            Err(e) => {
                log::warn!("dev bridge disabled: {e}");
                return;
            }
        };
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let token = token();
        let info = json!({ "port": port, "token": token, "pid": std::process::id() });
        let dir = app.state::<crate::AppCore>().0.paths.data_dir.clone();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("dev-bridge.json"), serde_json::to_vec_pretty(&info).unwrap_or_default());
        log::info!("dev bridge on http://127.0.0.1:{port} (token in {})", dir.join("dev-bridge.json").display());

        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let (path, query) = url.split_once('?').unwrap_or((&url, ""));
            let params: HashMap<String, String> =
                query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let header_token = req.headers().iter().find(|h| h.field.equiv("x-balader-token")).map(|h| h.value.as_str().to_string());
            if header_token.as_deref().or(params.get("token").map(String::as_str)) != Some(token.as_str()) {
                respond_json(req, 401, json!({ "ok": false, "error": "bad token" }));
                continue;
            }
            let method = req.method().clone();
            match (method, path) {
                (tiny_http::Method::Get, "/health") => respond_json(req, 200, json!({ "ok": true, "pid": std::process::id() })),
                (tiny_http::Method::Post, "/eval") => {
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    let timeout = params.get("timeout").and_then(|t| t.parse().ok()).unwrap_or(30);
                    match eval_js(&app, &body, Duration::from_secs(timeout)) {
                        Ok(v) => respond_json(req, 200, json!({ "ok": true, "value": v })),
                        Err(e) => respond_json(req, 500, json!({ "ok": false, "error": e })),
                    }
                }
                (tiny_http::Method::Get, "/state") => match eval_js(&app, "return window.__balader ? window.__balader.snapshot() : null;", Duration::from_secs(10)) {
                    Ok(v) => respond_json(req, 200, json!({ "ok": true, "value": v })),
                    Err(e) => respond_json(req, 500, json!({ "ok": false, "error": e })),
                },
                (tiny_http::Method::Get, "/events") => {
                    let n: usize = params.get("n").and_then(|n| n.parse().ok()).unwrap_or(50);
                    let q = EVENTS.lock().unwrap();
                    let items: Vec<Value> = q.iter().rev().take(n).rev().cloned().collect();
                    drop(q);
                    respond_json(req, 200, json!({ "ok": true, "value": items }));
                }
                (tiny_http::Method::Get, "/snapshot") => match snapshot(&app) {
                    Ok(png) => {
                        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap();
                        let _ = req.respond(tiny_http::Response::from_data(png).with_header(header));
                    }
                    Err(e) => respond_json(req, 501, json!({ "ok": false, "error": e })),
                },
                (tiny_http::Method::Post, "/reload") => {
                    let ok = app.get_webview_window("main").map(|w| w.eval("location.reload()").is_ok()).unwrap_or(false);
                    respond_json(req, 200, json!({ "ok": ok }));
                }
                _ => respond_json(req, 404, json!({ "ok": false, "error": "unknown route" })),
            }
        }
    });
}
