use crate::state::{escaped as e, text, State};
use serde_json::Value;

pub fn enabled(s: &State, action: &str, blocked: bool) -> bool {
    !s.busy
        && !blocked
        && s.form["banPassword"]
            .as_str()
            .is_some_and(|p| !p.is_empty())
        && (action != "ban-name"
            || s.form["banName"]
                .as_str()
                .is_some_and(|n| !n.trim().is_empty()))
}
fn field(s: &State, key: &str, label: &str, kind: &str, maximum: usize) -> String {
    format!("<div class=\"outlined-field ban-field\"><input id=\"ban-{key}\" type={kind} data-form={key} maxlength={maximum} autocomplete=off placeholder=\" \" value=\"{}\"><label for=\"ban-{key}\">{label}</label></div>", e(&text(&s.form[key])))
}
fn control(
    s: &State,
    action: &str,
    label: &str,
    class: &str,
    attributes: &str,
    blocked: bool,
) -> String {
    format!("<button type=button class=\"{class}\" data-action={action} data-ban-control data-ban-blocked={blocked} {attributes} {}>{label}</button>", if enabled(s,action,blocked){""}else{"disabled"})
}
fn value_or<'a>(v: &'a Value, fallback: &'a str) -> &'a str {
    v.as_str().filter(|v| !v.is_empty()).unwrap_or(fallback)
}
pub fn render(s: &State) -> String {
    let data = &s.result["bans"];
    let loaded = data["bans"].is_array();
    let ip_available = data["ipBansAvailable"] == true;
    let ip = s.form["banType"] == "ip" && ip_available;
    let mut html=String::from("<div class=ban-panel><p>UIDが分かるプレイヤーは直接登録できます。名前だけの場合は、同名の別人が先に接続するとそのUIDが登録されます。</p><div class=ban-control-row>");
    html.push_str(&field(
        s,
        "banPassword",
        "BAN管理者パスワード",
        "password",
        1024,
    ));
    html.push_str(&control(
        s,
        "ban-list",
        "一覧を読み込む",
        "ban-text",
        "",
        false,
    ));
    html.push_str("</div>");
    html.push_str(&field(s, "banReason", "登録理由（任意）", "text", 500));
    html.push_str(&format!("<div class=ban-type-group role=group aria-label=\"BANの対象\"><button type=button data-action=ban-type data-value=uid aria-pressed={} {}>ユーザー識別子（UID）</button><button type=button data-action=ban-type data-value=ip aria-pressed={} {}>IPアドレス</button></div>",!ip,if s.busy{"disabled"}else{""},ip,if s.busy||!ip_available{"disabled"}else{""}));
    html.push_str("<p class=ban-caption>IP BANは同じグローバルIPを使う他のユーザーにも適用されます。DBに記録済みの本人のIPを使用します。");
    if loaded && !ip_available {
        html.push_str(" IP BANはサーバーに未反映です。");
    }
    html.push_str("</p><div class=ban-control-row>");
    html.push_str(&field(
        s,
        "banName",
        "UID待ちのプレイヤー名（完全一致）",
        "text",
        80,
    ));
    html.push_str(&control(
        s,
        "ban-name",
        "名前で登録",
        "ban-danger-text",
        "",
        false,
    ));
    html.push_str(
        "</div><p class=ban-caption>名前での予約はユーザー識別子（UID）のBANとして登録します。</p>",
    );
    let notice = if s.notice().is_empty() {
        "管理者パスワードを入力して一覧を読み込んでください。".into()
    } else {
        s.notice()
    };
    html.push_str(&format!(
        "<p class=ban-caption role=status>{}</p><h4>現在のロビー</h4>",
        e(&notice)
    ));
    let mut players = 0;
    for player in s.effective_game()["players"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["playerUid"].as_str().is_some_and(|v| !v.is_empty()))
    {
        players += 1;
        let attrs = format!(
            "data-value=\"{}\" data-player-uid=\"{}\"",
            e(&text(&player["clientId"])),
            e(&text(&player["playerUid"]))
        );
        html.push_str(&format!(
            "<div class=ban-item><div><p>{}{} ／ Friend Code: {}</p></div>{}</div>",
            e(&text(&player["name"])),
            if player["isLocal"] == true {
                "（自分）"
            } else {
                ""
            },
            e(value_or(&player["friendCode"], "なし")),
            control(
                s,
                "ban-player",
                if ip {
                    "IPでBAN登録"
                } else {
                    "UIDでBAN登録"
                },
                "ban-danger-outline",
                &attrs,
                false
            )
        ));
    }
    if players == 0 {
        html.push_str("<p>ユーザー識別子の取得を待っています。</p>");
    }
    html.push_str("<button type=button class=ban-outline data-action=open-history>プレイヤー履歴を別ウィンドウで開く</button>");
    let count = if loaded {
        format!("{}人", data["historyTotal"].as_u64().unwrap_or(0))
    } else {
        "未読み込み".into()
    };
    html.push_str(&format!("<h4>DB登録済みプレイヤー（{count}）</h4>"));
    let history = data["history"].as_array();
    if loaded && data["historyAvailable"] == false {
        html.push_str("<p>履歴機能はサーバーに未反映です。</p>");
    } else if loaded && history.is_none_or(Vec::is_empty) {
        html.push_str("<p>記録されたプレイヤーはまだいません。</p>");
    }
    if let Some(records) = history.filter(|r| !r.is_empty()) {
        if (records.len() as u64) < data["historyTotal"].as_u64().unwrap_or(0) {
            html.push_str("<p>一部のみ取得できました。サーバーの更新を確認してください。</p>");
        }
        html.push_str("<div class=ban-history-list data-scroll-key=ban-history>");
        for item in records {
            let digest = text(&item["uid_digest"]);
            let short: String = digest
                .chars()
                .rev()
                .take(8)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            let uid = if item["uid_banned"].is_null() {
                crate::views::ban_flag(&item["is_banned"])
            } else {
                crate::views::ban_flag(&item["uid_banned"])
            };
            let friend = item["friend_code"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(|v| format!(" ／ {}", e(v)))
                .unwrap_or_default();
            html.push_str(&format!("<div class=ban-history-item><p>{} ／ ID: …{}{friend} ／ IP: {}</p><p class=ban-caption>UID: {} ／ IP: {}</p><p class=ban-caption>初回: {} ／ 最終: {}</p></div>",e(&text(&item["display_name"])),e(&short),e(value_or(&item["public_ip"],"未取得")),if uid{"BAN済み"}else{"未BAN"},if item["ip_banned"].is_null(){"未確認"}else if crate::views::ban_flag(&item["ip_banned"]){"BAN済み"}else{"未BAN"},e(&crate::views::seen_at(&item["first_seen_at"])),e(&crate::views::seen_at(&item["last_seen_at"]))));
        }
        html.push_str("</div>");
    }
    html.push_str("<h4>UID待ち</h4>");
    for item in data["pending"].as_array().into_iter().flatten() {
        let reason = item["reason"]
            .as_str()
            .filter(|r| !r.is_empty())
            .map(|r| format!(" ／ {}", e(r)))
            .unwrap_or_default();
        html.push_str(&format!(
            "<div class=ban-item><div><p>{}{reason}</p></div>{}</div>",
            e(&text(&item["player_name"])),
            control(
                s,
                "ban-remove-name",
                "解除",
                "ban-text",
                &format!("data-value=\"{}\"", e(&text(&item["player_name"]))),
                false
            )
        ));
    }
    html.push_str("<h4>登録済み</h4>");
    for item in data["bans"].as_array().into_iter().flatten() {
        let ip = item["ban_type"] == "ip";
        let id = &item[if ip { "public_ip" } else { "uid_digest" }];
        let extra = [("friend_code", ""), ("reason", "")]
            .iter()
            .filter_map(|(key, _)| item[*key].as_str().filter(|v| !v.is_empty()))
            .map(|v| format!(" ／ {}", e(v)))
            .collect::<String>();
        let attrs = format!(
            "data-value=\"{}\" data-ban-type={} data-history=false",
            e(&text(id)),
            if ip { "ip" } else { "uid" }
        );
        html.push_str(&format!("<div class=ban-item><div><p>{} ／ {} BAN ／ UID: {} ／ IP: {}{extra}</p></div>{}</div>",e(value_or(&item["display_name"],"名前なし")),if ip{"IP"}else{"UID"},e(value_or(&item["player_uid"],"旧登録・未保存")),e(value_or(&item["public_ip"],"未取得")),control(s,"ban-record","解除","ban-text",&attrs,ip&&!ip_available)));
    }
    html.push_str("</div>");
    html
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn blank_password_and_unavailable_ip_never_enable_mutations() {
        let mut s = State::for_view("debug", "test");
        assert!(!enabled(&s, "ban-list", false));
        assert!(!enabled(&s, "ban-name", false));
        s.form["banPassword"] = json!("synthetic");
        assert!(enabled(&s, "ban-list", false));
        assert!(!enabled(&s, "ban-name", false));
        s.form["banName"] = json!("player");
        assert!(enabled(&s, "ban-name", false));
        assert!(!enabled(&s, "ban-record", true));
        s.busy = true;
        assert!(!enabled(&s, "ban-player", false));
    }
    #[test]
    fn release_panel_groups_controls_and_keeps_history_read_only() {
        let mut s = State::for_view("debug", "test");
        s.result["bans"] = json!({"bans":[],"pending":[],"history":[{"uid_digest":"id","display_name":"<fixture>","uid_banned":1}],"historyTotal":1,"historyAvailable":true,"ipBansAvailable":false});
        let html = render(&s);
        assert!(html.contains("aria-label=\"BANの対象\""));
        assert!(html.contains("&lt;fixture&gt;"));
        assert!(html.contains("UID: BAN済み"));
        assert!(!html.contains("data-history=true"));
        assert!(html.find("DB登録済みプレイヤー").unwrap() < html.find("<h4>UID待ち").unwrap());
        assert!(html.contains("data-action=open-history"));
    }
}
