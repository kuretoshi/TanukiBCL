//! The background engine follows the same access check as the React view.
//! HTTP runs outside the voice loop; results from old identities are discarded.
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
#[derive(Default)]
pub struct Access {
    key: String,
    status: String,
    next: Option<Instant>,
    task: Option<tokio::task::JoinHandle<String>>,
}
impl Drop for Access {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
impl Access {
    pub fn status(&self) -> &str {
        &self.status
    }
    pub fn update(&mut self, app: Option<&AppHandle>, state: &Value) -> bool {
        let Some(app) = app else { return true };
        let Some(me) = super::model::local(state) else {
            self.clear();
            return true;
        };
        let uid = me["playerUid"].as_str().unwrap_or("").trim();
        if uid.is_empty() {
            self.clear();
            return true;
        }
        let name = me["name"].as_str().unwrap_or("").trim();
        let friend = me["friendCode"].as_str().unwrap_or("").trim();
        let key = format!("{uid}\0{name}\0{friend}");
        if key != self.key {
            self.clear();
            self.key = key;
            self.status = "checking".into();
        }
        if self.task.as_ref().is_some_and(|t| t.is_finished()) {
            let task = self.task.take().unwrap();
            match futures_util::FutureExt::now_or_never(task) {
                Some(Ok(result)) => self.status = result,
                _ => self.status = "unavailable".into(),
            }
        }
        if self.task.is_none() && self.next.is_none_or(|t| Instant::now() >= t) {
            self.next = Some(Instant::now() + Duration::from_secs(15));
            let observed:Vec<_>=state["players"].as_array().into_iter().flatten().filter(|p|p["isLocal"]!=true&&p["disconnected"]!=true&&p["isDummy"]!=true).take(29).map(|p|json!({"playerUid":p["playerUid"].as_str().unwrap_or("").trim(),"playerName":p["name"].as_str().unwrap_or("").trim(),"friendCode":p["friendCode"].as_str().unwrap_or("").trim()})).collect();
            let args = vec![json!(uid), json!(name), json!(friend), json!(observed)];
            let backend = app.state::<Arc<crate::Backend>>().inner().clone();
            self.task = Some(tokio::spawn(async move {
                backend
                    .request("main", "player-bans:check", args, "invoke")
                    .await
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or("unavailable".into())
            }));
        }
        self.status == "clear"
    }
    pub fn error(&self) -> &str {
        match self.status.as_str() {
            "checking" => "参加可否を確認しています",
            "banned" => "このアカウントは通話を利用できません",
            "unavailable" => "参加可否を確認できません。再試行しています",
            _ => "",
        }
    }
    fn clear(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
        self.key.clear();
        self.status.clear();
        self.next = None;
    }
}
