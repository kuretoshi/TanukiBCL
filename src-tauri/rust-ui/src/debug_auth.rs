use crate::state::State;
use serde_json::{json, Value};

pub fn begin(s: &mut State) -> Option<Value> {
    if s.form["debugAuthenticating"] == true {
        return None;
    }
    let password = s.form["debugPassword"]
        .as_str()
        .filter(|p| !p.is_empty() && p.encode_utf16().count() <= 1024)?
        .to_owned();
    s.form["debugAuthenticating"] = json!(true);
    s.form["debugError"] = json!("");
    s.form["debugPassword"] = Value::Null;
    Some(json!(password))
}
pub fn finish(s: &mut State, result: Result<Value, String>) {
    s.form["debugAuthenticating"] = json!(false);
    s.form["debugPassword"] = Value::Null;
    let error = match result.as_ref().ok().and_then(Value::as_str) {
        Some("authorized") => {
            s.form["debugDialog"] = json!(false);
            s.message = "デバッグ情報を開きました".into();
            ""
        }
        Some("unavailable") => {
            "認証サーバーに接続できないか、混雑しています。時間をおいて再試行してください。"
        }
        Some("pending") => "認証中です。少しお待ちください。",
        Some("retry") => "続けて認証しています。1秒ほど待って再試行してください。",
        Some("denied") => {
            "認証できませんでした。配布されたデバッグ用パスワードを確認してください。"
        }
        _ => "認証処理に失敗しました。再試行してください。",
    };
    s.form["debugError"] = json!(error);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_request_preserves_typed_password_and_clears_it_after_failure() {
        let mut s = State::for_view("settings", "test");
        s.form = json!({"debugDialog":true,"debugPassword":"synthetic password"});
        assert_eq!(begin(&mut s), Some(json!("synthetic password")));
        assert!(begin(&mut s).is_none());
        finish(&mut s, Ok(json!("retry")));
        assert!(s.form["debugDialog"] == true);
        assert!(s.form["debugPassword"].is_null());
        assert!(s.form["debugError"].as_str().unwrap().contains("1秒"));
        assert!(begin(&mut s).is_none());
        s.form["debugPassword"] = json!("another synthetic password");
        assert!(begin(&mut s).is_some());
        finish(&mut s, Ok(json!("authorized")));
        assert!(s.form["debugDialog"] == false);
        assert!(s.form["debugPassword"].is_null());
    }
    #[test]
    fn failure_and_network_errors_remain_in_the_dialog() {
        for result in [
            Ok(json!("denied")),
            Ok(json!("unavailable")),
            Err("IPC failed".into()),
        ] {
            let mut s = State::for_view("settings", "test");
            s.form = json!({"debugDialog":true,"debugAuthenticating":true});
            finish(&mut s, result);
            assert!(s.form["debugDialog"] == true);
            assert!(s.form["debugAuthenticating"] == false);
            assert!(!s.form["debugError"].as_str().unwrap().is_empty());
        }
    }
}
