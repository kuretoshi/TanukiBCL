use crate::state::{escaped as e, State};
use serde_json::Value;
use std::sync::OnceLock;
pub fn icon(name: &str) -> &'static str {
    static ICONS: OnceLock<Value> = OnceLock::new();
    ICONS.get_or_init(|| serde_json::from_str(include_str!("../assets/icons.json")).unwrap())[name]
        .as_str()
        .unwrap_or("")
}
pub fn icon_button(action: &str, name: &str, label: &str, class: &str) -> String {
    format!("<button type=button class=\"icon-button {class}\" data-action=\"{}\" aria-label=\"{}\" title=\"{}\">{}</button>",e(action),e(label),e(label),icon(name))
}
pub fn header(s: &State) -> String {
    if s.view == "overlay" || s.view == "player-history" {
        return String::new();
    }
    if s.view == "app" {
        return format!("<header class=app-titlebar data-drag>{}{}<span class=app-title>タヌキのベタクル v{}</span>{}</header>",icon_button("open-settings","Settings","設定","title-settings"),icon_button("reload","RefreshSharp","Reload","title-reload"),e(&s.version),icon_button("close","Close","閉じる","title-close"));
    }
    if s.view == "lobbies" {
        return format!(
            "<header class=lobby-titlebar data-drag><span>LobbyBrowser</span>{}{}{}</header>",
            icon_button("refresh-lobbies", "RefreshSharp", "Reload", "title-reload"),
            icon_button("minimize", "Remove", "最小化", ""),
            icon_button("close", "Close", "閉じる", "title-close")
        );
    }
    let (name, glyph) = match s.view.as_str() {
        "settings" => (s.t("settings.title"), "Settings"),
        "lobbies" => (s.t("buttons.public_lobby"), "Groups"),
        "debug" => ("デバッグ情報".into(), "Science"),
        _ => ("プレイヤー履歴".into(), "Person"),
    };
    format!(
        "<header class=window-titlebar data-drag><span class=window-title>{}{}</span>{}{}</header>",
        icon(glyph),
        e(&name),
        icon_button("minimize", "Remove", "最小化", ""),
        icon_button("close", "Close", "閉じる", "")
    )
}
pub fn footer(s: &State) -> String {
    let link = |name: &str, label: &str, url: &str| {
        format!("<button class=footer-icon type=button data-action=open-link data-value=\"{url}\" aria-label=\"{label}\" title=\"{label}\">{}</button>",icon(name))
    };
    format!("<footer class=electron-footer><div class=footer-row>{}{}<div class=support-anchor>{}{}</div>{}</div></footer>",link("GitHub","GitHubのページはこちら","https://github.com/kuretoshi/BetterCrewLink/tree/voice_fixed"),link("Discord","サポート用のDiscordに参加","https://discord.gg/jEyDrpBsmJ"),icon_button("toggle-support","Support","支援先を選ぶ","footer-icon"),if s.form["supportMenu"]==true{"<div class=popup-menu role=menu><button data-action=open-link data-value=https://ko-fi.com/kuretoshi>Ko-fiで支援する</button><button data-action=open-link data-value=https://github.com/sponsors/kuretoshi>GitHub Sponsorsで支援する</button></div>"}else{""},link("X","Xのページはこちら","https://x.com/tanukibcl?s=11"))
}
/// Exact port of renderer/views/playerGridLayout.ts (v3.2.62).
pub fn player_grid(width: f64, height: f64, count: usize, split: Option<usize>) -> (usize, u32) {
    if count == 0 {
        return (1, 100);
    }
    let max: f64 = if split.is_some() { 80.0 } else { 100.0 };
    let alive = split.unwrap_or(count).min(count);
    let ghosts = count - alive;
    let headers = if split.is_some() {
        usize::from(alive > 0) + usize::from(ghosts > 0)
    } else {
        0
    };
    let (mut best_columns, mut best_rows, mut best, mut five) = (1, count, 0.0f64, 0.0f64);
    for columns in 1..=count {
        let rows = alive.div_ceil(columns) + ghosts.div_ceil(columns);
        let size = max
            .min((width - 8.0 * (columns - 1) as f64) / columns as f64 - 6.0)
            .min(
                (height - 18.0 * headers as f64 - 8.0 * (rows + headers - 1) as f64) / rows as f64
                    - 6.0,
            );
        if columns == 5 {
            five = size;
        }
        if size > best || (size == best && rows < best_rows) {
            best_columns = columns;
            best_rows = rows;
            best = size;
        }
    }
    if count >= 12
        && best_columns < 5
        && five >= (if split.is_some() { 20.0f64 } else { 30.0f64 }).max(best * 0.85)
    {
        return (5, five.floor() as u32);
    }
    (best_columns, best.floor().max(1.0) as u32)
}
