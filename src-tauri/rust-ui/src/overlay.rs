//! Overlay layout and meeting ordering follow the pinned 3.2.62 renderer.
use crate::{
    state::{escaped as e, text, State},
    views,
};
use serde_json::Value;
pub fn reconcile(s: &mut State) {
    if s.effective_game()["gameState"] != 2 {
        s.meeting_ids.clear();
        s.meeting_started = 0.0;
        return;
    }
    let mut players: Vec<Value> = s.effective_game()["players"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if s.meeting_started == 0.0 {
        s.meeting_started = js_sys::Date::now();
    }
    if !s.meeting_ids.is_empty()
        && (js_sys::Date::now() - s.meeting_started > 4000.0
            || !s
                .meeting_ids
                .iter()
                .all(|id| players.iter().any(|p| p["id"].as_i64() == Some(*id))))
    {
        return;
    }
    if !s.meeting_ids.is_empty() {
        players.retain(|p| s.meeting_ids.contains(&p["id"].as_i64().unwrap_or(-1)));
    }
    players.sort_by_key(|p| {
        (
            p["isDead"] == true || p["disconnected"] == true,
            p["id"].as_i64().unwrap_or(255),
        )
    });
    s.meeting_ids = players.iter().filter_map(|p| p["id"].as_i64()).collect();
}
fn page_ids(game: &Value, fallback: &[i64]) -> Vec<i64> {
    let players = game["players"].as_array();
    let meeting = &game["snrMeeting"];
    if game["mod"] != "SUPER_NEW_ROLES"
        || (meeting["enabled"] != true && players.is_none_or(|p| p.len() <= 15))
    {
        return fallback.to_vec();
    }
    let Some(ids) = meeting["playerIds"].as_array() else {
        return Vec::new();
    };
    let Some(page) = meeting["currentPage"]
        .as_u64()
        .filter(|p| *p >= 1 && *p <= (ids.len() as u64).div_ceil(15))
    else {
        return Vec::new();
    };
    if meeting["enabled"] != true || ids.len() > 256 {
        return Vec::new();
    }
    let mut validated = Vec::new();
    for id in ids {
        let Some(id) = id.as_i64().filter(|id| (0..255).contains(id)) else {
            return Vec::new();
        };
        if validated.contains(&id) {
            return Vec::new();
        }
        validated.push(id);
    }
    validated
        .into_iter()
        .skip((page as usize - 1) * 15)
        .take(15)
        .collect()
}
fn nos_card(
    width: f64,
    height: f64,
    vw: f64,
    vh: f64,
    count: usize,
    index: usize,
) -> (f64, f64, f64, f64) {
    let (columns, scale, dx, dy, stepx, stepy) = if count <= 18 {
        (3, 0.95, 0.1, 0.145, 1.0, 0.89)
    } else {
        (4, 0.76, -0.355, 0.0, 0.974, 1.0)
    };
    let unit = (vh / 6.0).min(vw / (8.54 * 1.2));
    let w = 2.7 * scale * unit;
    let h = 0.63 * scale * unit;
    (
        width / 2.0 + (-3.1 + 0.25 + dx + (index % columns) as f64 * 2.9 * scale * stepx) * unit
            - w / 2.0,
        height / 2.0
            - (1.5 + dy - (index / columns) as f64 * 0.76 * scale * stepy) * unit
            - h / 2.0,
        w,
        h,
    )
}
fn meeting(s: &State) -> String {
    let game = s.effective_game();
    if s.settings["meetingOverlay"] != true || game["gameState"] != 2 {
        return String::new();
    }
    let window = web_sys::window().unwrap();
    let vw = window
        .inner_width()
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(1920.0);
    let vh = window
        .inner_height()
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(1080.0);
    let old = game["oldMeetingHud"] == true;
    let (width, height) = if old {
        let ratio = 854.0 / 579.0;
        let w = if vw / (vh * 0.96) > ratio {
            vw * 0.96 * ratio
        } else {
            vw
        };
        (w, w)
    } else {
        let diff = (vw / vh - 1.7).abs();
        let w = vw
            / if diff < 0.25 {
                1.192
            } else if diff < 0.5 {
                1.146
            } else {
                1.591
            };
        (w, w / 1.72)
    };
    let large = game["mod"] == "NoS" && !old && s.meeting_ids.len() > 15;
    let mut cards = String::new();
    for (index, id) in page_ids(game, &s.meeting_ids).iter().enumerate() {
        let player = game["players"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"].as_i64() == Some(*id));
        let talking = player.is_some_and(|p| {
            s.snapshot()["otherTalking"][text(&p["clientId"])] == true
                || p["isLocal"] == true && s.voice["status"]["talking"] == true
        });
        let color = player
            .and_then(|p| {
                if game["mod"] == "NoS" {
                    crate::avatar::nos_color(p)
                } else {
                    None
                }
            })
            .or_else(|| {
                player.and_then(|p| {
                    s.context["playerColors"][p["colorId"].as_u64().unwrap_or(0) as usize][0]
                        .as_str()
                        .map(str::to_owned)
                })
            })
            .filter(|c| {
                c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
            })
            .unwrap_or("#C51111".into());
        let style = if large {
            let (x, y, w, h) = nos_card(width, height, vw, vh, s.meeting_ids.len(), index);
            format!("position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;margin:0;")
        } else {
            format!(
                "width:{}%;height:{}%;margin-bottom:{}%;margin-right:{}%;margin-left:{}%;",
                if old { 46.41 } else { 30.0 },
                if old { 100.0 } else { 109.0 },
                if old { 2.0 } else { 1.9 },
                if old { 2.34 } else { 0.23 },
                if old { 0.0 } else { 2.4 }
            )
        };
        cards.push_str(&format!("<div data-meeting-player={id} class=meeting-card style=\"{style}opacity:{};border-radius:{}px;box-shadow:0 0 {}px {}px {}\"></div>",if talking{1}else{0},height/100.0,height/100.0,height/100.0,e(&color)));
    }
    format!("<div class=meeting-hud style=\"width:{width}px;height:{height}px\"><div class=meeting-tablet style=\"width:{}%;height:{}%;left:{}%;top:{}%\">{cards}</div></div>",if large{100.0}else if old{88.45}else{100.0},if large{100.0}else{10.5},if large{0.0}else if old{4.7}else{0.4},if large{0.0}else if old{18.4703}else{15.0})
}
pub fn render(s: &State) -> String {
    let game = s.effective_game();
    if s.settings["enableOverlay"] != true || game.is_null() || game["gameState"] == 3 {
        return "<div class=overlay-surface></div>".into();
    }
    let mode = game["mod"].as_str().unwrap_or("NONE");
    let mod_name = match mode {
        "NONE" => "",
        "SUPER_NEW_ROLES" => "SuperNewRoles",
        other => other,
    };
    let watermark=format!("<div class=\"tanuki-overlay-watermark{}{}{}\"><div>TanukiBCL v{} [{}]</div><div>{}</div>{}</div>",if mode=="SUPER_NEW_ROLES"{" tanuki-overlay-watermark_snr"}else{""},if game["gameState"]==1{" tanuki-overlay-watermark_game"}else{""},if mode=="NoS"{" tanuki-overlay-watermark_nos"}else{""},e(&s.version),e(mod_name),e(&text(&s.settings["serverURL"])),if mode=="NoS"&&game["nosReadStatus"]["failed"]==true{format!("<div class=notice>{}</div>",e(&text(&game["nosReadStatus"]["message"])))}else{String::new()});
    let position = s.settings["overlayPosition"].as_str().unwrap_or("right");
    let valid = [
        "right",
        "right1",
        "left",
        "left1",
        "top",
        "bottom_left",
        "hidden",
    ]
    .contains(&position);
    let position = if valid { position } else { "right" };
    let mut avatars = String::new();
    let mut avatar_count = 0usize;
    if position != "hidden" {
        let compact = s.settings["compactOverlay"] == true;
        let side = position.starts_with("left") || position.starts_with("right");
        let show_name = game["mixupSabotaged"] != true
            && game["camouflaged"] != true
            && side
            && (!compact || position.ends_with('1'));
        let mut players: Vec<_> = game["players"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                s.snapshot()["localIsAlive"] != true
                    || p["isLocal"] == true
                    || s.snapshot()["otherDead"][text(&p["clientId"])] != true
            })
            .collect();
        players.sort_by_key(|p| {
            (
                p["disconnected"] == true
                    || s.snapshot()["otherDead"][text(&p["clientId"])] == true,
                p["id"].as_i64().unwrap_or(0),
            )
        });
        for player in players {
            let local = player["isLocal"] == true;
            let id = text(&player["clientId"]);
            let hidden =
                player["shiftedColor"].as_i64().is_some_and(|v| v != -1) && game["gameState"] != 2;
            let clone_talking = s.snapshot()["cloneTalking"][&id] == true;
            let talking = clone_talking
                || (!hidden || local)
                    && (s.snapshot()["otherTalking"][&id] == true
                        || local && s.voice["status"]["talking"] == true);
            let connected = s.snapshot()["playerSocketIds"][&id]
                .as_str()
                .is_some_and(|socket| {
                    s.snapshot()["socketClients"][socket]["clientId"] == player["clientId"]
                });
            if (!local && !connected) || (compact && !talking) {
                continue;
            }
            let html = views::avatar(s, player);
            avatar_count += 1;
            avatars.push_str(&format!(
                "<div class=\"player_wrapper{}{}\"><div>{html}</div></div>",
                if show_name { " show-name" } else { "" },
                if talking { " active" } else { "" }
            ));
        }
    }
    let height = web_sys::window()
        .and_then(|w| w.inner_height().ok())
        .and_then(|v| v.as_f64())
        .unwrap_or(1080.0);
    let zoom = (height * 0.075 * (10.0 / avatar_count.max(10) as f64) / 60.0).clamp(0.1, 2.0);
    format!("<div class=overlay-surface>{watermark}{}<div class=\"overlay-wrapper gamestate_game overlay_postion_{} overlay_postion_{} {}\" style=\"--overlay-zoom:{zoom}\"><div class=otherplayers><div class=players_container>{avatars}</div></div></div></div>",meeting(s),e(position.trim_end_matches('1')),e(position),if s.settings["compactOverlay"]==true||position.ends_with('1'){"compactoverlay"}else{""})
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn snr_slots_do_not_shift_on_missing_players() {
        let game = json!({"mod":"SUPER_NEW_ROLES","players":[],"snrMeeting":{"enabled":true,"currentPage":2,"playerIds":(0..20).collect::<Vec<_>>()}});
        assert_eq!(page_ids(&game, &[]), vec![15, 16, 17, 18, 19]);
        let mut bad = game.clone();
        bad["snrMeeting"]["playerIds"] = json!([1, 1]);
        assert!(page_ids(&bad, &[]).is_empty());
    }
    #[test]
    fn nos_large_meeting_preserves_source_geometry() {
        let (x, y, w, h) = nos_card(1600.0, 930.0, 1920.0, 1080.0, 19, 0);
        assert!((w - 369.36).abs() < 0.001);
        assert!((h - 86.184).abs() < 0.001);
        assert!((x - 38.42).abs() < 0.001);
        assert!((y - 151.908).abs() < 0.001);
    }
}
