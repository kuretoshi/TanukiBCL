use crate::state::{escaped as e, text, State};
use serde_json::Value;
use std::future::Future;

pub fn controls(state: &Value, busy: bool) -> (bool, bool) {
    let phase = state["state"].as_str().unwrap_or("idle");
    let checking = busy || matches!(phase, "checking" | "downloading");
    let start = !checking && start_channel(state).is_some();
    (!checking, start)
}

fn start_channel(state: &Value) -> Option<&'static str> {
    state["info"]["version"]
        .as_str()
        .filter(|v| !v.is_empty())?;
    match state["state"].as_str()? {
        "available" => Some("update-app"),
        "downloaded" => Some("RESTART_AND_UPDATE"),
        _ => None,
    }
}

// Keep the verified Tauri download/install backend. The single Start button
// only proceeds to installation after a successful completed download.
pub async fn start<F, R>(state: &Value, mut request: F) -> Result<Value, String>
where
    F: FnMut(&'static str) -> R,
    R: Future<Output = Result<Value, String>>,
{
    let channel = start_channel(state).ok_or("先にアップデートを確認してください。")?;
    let result = request(channel).await?;
    if channel == "RESTART_AND_UPDATE" {
        return Ok(result);
    }
    if result["state"] != "downloaded" {
        return Err(result["error"]
            .as_str()
            .unwrap_or("アップデートを取得できませんでした。")
            .into());
    }
    request("RESTART_AND_UPDATE").await
}

pub fn render(s: &State) -> String {
    let state = &s.updater;
    let phase = state["state"].as_str().unwrap_or("idle");
    let (check, start) = controls(state, s.busy);
    let mut status = String::new();
    if let Some(version) = state["info"]["version"].as_str() {
        status.push_str(&format!("<p>最新バージョンv{}</p>", e(version)));
    }
    match phase {
        "checking" => status.push_str("<p>アップデートを確認中…</p>"),
        "unavailable" | "not-available" => status.push_str("<p>最新バージョンです</p>"),
        "downloading" => {
            let value = state["progress"]["percent"]
                .as_f64()
                .or_else(|| state["percent"].as_f64())
                .filter(|n| n.is_finite())
                .map(|n| format!(" value={}", n.clamp(0.0, 100.0)))
                .unwrap_or_default();
            status.push_str(&format!("<p>ダウンロード中…</p><progress class=update-progress max=100{value} aria-label=\"アップデートのダウンロード\"></progress>"));
        }
        "downloaded" => status.push_str("<p>アップデートの準備ができました。</p>"),
        "error" => status.push_str(&format!(
            "<div class=update-error role=alert>アップデートを確認・取得できませんでした。{}</div>",
            e(&text(&state["error"]))
        )),
        "available" => {}
        _ => status.push_str("<p>アップデートを確認してください。</p>"),
    }
    let manual = if phase == "error" {
        "<button type=button class=update-manual data-action=open-link data-value=\"https://github.com/kuretoshi/TanukiBCL/releases\">手動でダウンロード</button>"
    } else {
        ""
    };
    crate::settings::section("アップデート", format!(
        "<div class=update-content><div class=update-status aria-live=polite>{status}</div>\
         <div class=update-actions><button type=button data-action=check-updates {check_disabled}>アップデートを確認</button>\
         <button type=button class=update-start data-action=start-update {start_disabled}>アップデート開始</button></div>\
         <p class=update-note>アップデート開始後は、ダウンロード完了時にアプリを終了して更新します。</p>{manual}</div>",
        check_disabled = if check { "" } else { "disabled" },
        start_disabled = if start { "" } else { "disabled" },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::task::{Context, Poll, Waker};
    fn ready<T>(future: impl Future<Output = T>) -> T {
        match std::pin::pin!(future)
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("mock IPC must be ready"),
        }
    }
    #[test]
    fn start_downloads_then_installs_once_and_reuses_completed_download() {
        let mut calls = Vec::new();
        let state = json!({"state":"available","info":{"version":"3.2.70-tauri-beta.1"}});
        let result = ready(start(&state, |channel| {
            calls.push(channel);
            std::future::ready(Ok(json!({"state":"downloaded"})))
        }));
        assert!(result.is_ok());
        assert_eq!(calls, ["update-app", "RESTART_AND_UPDATE"]);
        calls.clear();
        assert!(ready(start(
            &json!({"state":"downloaded","info":{"version":"3.2.70-tauri-beta.1"}}),
            |channel| {
                calls.push(channel);
                std::future::ready(Ok(Value::Null))
            }
        ))
        .is_ok());
        assert_eq!(calls, ["RESTART_AND_UPDATE"]);
    }
    #[test]
    fn failed_incomplete_or_unchecked_download_never_installs() {
        let available = json!({"state":"available","info":{"version":"new"}});
        for result in [
            Err("offline".into()),
            Ok(json!({"state":"error","error":"checksum"})),
            Ok(json!({"state":"downloading"})),
        ] {
            let mut calls = Vec::new();
            assert!(ready(start(&available, |channel| {
                calls.push(channel);
                std::future::ready(result.clone())
            }))
            .is_err());
            assert_eq!(calls, ["update-app"]);
        }
        for state in [
            Value::Null,
            json!({"state":"available"}),
            json!({"state":"downloading","info":{"version":"new"}}),
        ] {
            assert!(ready(start(&state, |_| {
                panic!("unchecked update issued IPC");
                #[allow(unreachable_code)]
                std::future::ready(Ok(Value::Null))
            }))
            .is_err());
        }
    }
    #[test]
    fn update_buttons_follow_release_states_and_error_recovery() {
        let mut s = State::for_view("settings", "test");
        for phase in [
            "idle",
            "checking",
            "available",
            "downloading",
            "downloaded",
            "error",
            "not-available",
        ] {
            s.updater = json!({"state":phase,"info":{"version":"new"},"percent":150});
            let html = render(&s);
            assert!(html.contains("アップデートを確認</button>"));
            assert!(html.contains("アップデート開始</button>"));
            assert!(!html.contains("download-update") && !html.contains("install-update"));
            assert_eq!(
                controls(&s.updater, false),
                (
                    !matches!(phase, "checking" | "downloading"),
                    matches!(phase, "available" | "downloaded")
                )
            );
            assert_eq!(controls(&s.updater, true), (false, false));
            assert_eq!(html.contains("手動でダウンロード"), phase == "error");
            if phase == "downloading" {
                assert!(html.contains("value=100"));
            }
        }
    }
}
