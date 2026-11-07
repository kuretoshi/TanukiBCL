use crate::{
    settings::button,
    state::{escaped as e, text, State},
};
use serde_json::{json, Value};
pub fn avatar(s: &State, p: &Value) -> String {
    use crate::avatar as a;
    let client = text(&p["clientId"]);
    let local = p["isLocal"] == true;
    let voice = s.snapshot();
    let dead = if local {
        p["isDead"] == true
    } else {
        voice["otherDead"][&client]
            .as_bool()
            .unwrap_or(p["isDead"] == true)
    };
    let vad_hidden =
        p["shiftedColor"].as_i64().is_some_and(|v| v != -1) && s.effective_game()["gameState"] != 2;
    let talking = (local || !vad_hidden)
        && if local {
            s.voice["status"]["talking"] == true
        } else {
            voice["otherTalking"][&client] == true
        };
    let outfit = matches!(p["currentOutfit"].as_i64(), Some(1..=10));
    let color = if outfit && p["appearanceColorId"].as_i64().is_some_and(|v| v >= 0) {
        p["appearanceColorId"].as_i64().unwrap()
    } else {
        p["colorId"].as_i64().unwrap_or(0)
    };
    let id = |part: &str| -> String {
        let nos = &p["nosPlayer"][part]["name"];
        let appearance = &p[format!(
            "appearance{}Id",
            match part {
                "hat" => "Hat",
                "skin" => "Skin",
                _ => "Visor",
            }
        )];
        if s.effective_game()["mod"] == "NoS" && nos.is_string() {
            text(nos)
        } else if outfit
            || appearance
                .as_str()
                .is_some_and(|s| s.starts_with("Modded_"))
        {
            text(appearance)
        } else {
            text(&p[format!("{part}Id")])
        }
    };
    let hat = id("hat");
    let skin = id("skin");
    let visor = id("visor");
    let nos = |part: &str| {
        if s.effective_game()["mod"] == "NoS" {
            p["nosCosmetics"][part].as_str()
        } else {
            None
        }
    };
    let mut layers = String::new();
    layers.push_str(&a::cosmetic(s, &hat, "hat-back", color, nos("hatBack")));
    layers.push_str(
        &a::cosmetic(s, &text(&p["snrHat2Id"]), "hat-back", color, None)
            .replace("cosmetic hat-back", "cosmetic hat2-back"),
    );
    layers.push_str("<div class=body-group>");
    layers.push_str(&a::image(&a::base(s, p, !dead, color), "base", "", false));
    layers.push_str(&a::cosmetic(s, &skin, "skin", color, nos("skin")));
    if let Some(mask) = nos("bodyMask") {
        layers.push_str(&a::image(mask, "mask-loader", "display:none", false));
    }
    layers.push_str("</div>");
    layers.push_str(
        &a::cosmetic(s, &text(&p["snrHat2Id"]), "hat-front", color, None)
            .replace("cosmetic hat-front", "cosmetic hat2-front"),
    );
    layers.push_str(
        &a::cosmetic(s, &text(&p["snrVisor2Id"]), "visor", color, None)
            .replace("cosmetic visor", "cosmetic visor2"),
    );
    layers.push_str(&a::cosmetic(s, &hat, "hat-front", color, nos("hat")));
    layers.push_str(&a::cosmetic(s, &visor, "visor", color, nos("visor")));
    let muted = if local {
        s.voice["muted"] == true
    } else {
        let id = text(&p["playerConfigId"]);
        s.settings["playerConfigMap"][&id]["isMuted"] == true
            || s.settings["playerConfigMap"][&id]["volume"].as_f64() == Some(0.0)
    };
    let marker = if local && s.voice["deafened"] == true {
        crate::chrome::icon("VolumeOff")
    } else if muted {
        crate::chrome::icon("MicOff")
    } else if !local
        && voice["playerSocketIds"][&client]
            .as_str()
            .is_none_or(|socket| voice["audioConnected"][socket] != true)
    {
        if voice["socketClients"][voice["playerSocketIds"][&client].as_str().unwrap_or("")]
            ["clientId"]
            == p["clientId"]
        {
            crate::chrome::icon("LinkOff")
        } else {
            crate::chrome::icon("WifiOff")
        }
    } else {
        ""
    };
    let role = if s.view == "debug" {
        role_label(p)
    } else {
        String::new()
    };
    let talking = talking && (local || p["inVent"] != true);
    let class = if talking { " talking" } else { "" };
    let name = p["appearanceName"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or(p["name"].as_str().unwrap_or(""));
    let radio = s.snapshot()["impostorRadioClientIds"]
        .as_array()
        .is_some_and(|ids| ids.contains(&p["clientId"]));
    let control = if !local && s.view == "app" {
        format!(" data-action=player-popup data-value=\"{}\"", e(&client))
    } else {
        String::new()
    };
    let hidden =
        s.view == "app" && s.effective_game()["gameState"] == 1 && a::appearance_changed(p);
    let socket = voice["playerSocketIds"][&client].as_str().unwrap_or("");
    let connected = if local {
        s.voice["status"]["connected"] == true
    } else {
        voice["audioConnected"][socket] == true
    };
    let quality = if local {
        &voice["serverQuality"]
    } else {
        &voice["connectionQuality"][socket]
    };
    format!("<article class=\"player{class}{}{}{}\" data-player=\"{}\"{control}><div class=avatar><div class=avatar-paint>{layers}{}</div><span class=badge>{marker}</span>{}</div><strong>{}</strong><small>{}</small></article>",if dead{" ghost"}else{""},if vad_hidden&&local{" vad-hidden"}else{""},if hidden{" appearance-hidden"}else{""},e(&client),if radio{format!("<span class=radio-icon>{}</span>",crate::chrome::icon("Radio"))}else{String::new()},quality_indicator(connected,quality),e(name),e(&role))
}
fn quality_indicator(connected: bool, quality: &Value) -> String {
    let ping = quality["serverPingMs"]
        .as_f64()
        .or_else(|| quality["rttMs"].as_f64())
        .filter(|n| n.is_finite() && *n >= 0.0);
    let jitter = quality["jitterMs"].as_f64().unwrap_or(0.0);
    let bars = if !connected || ping.is_none() {
        0
    } else if ping.unwrap() >= 300.0 || jitter >= 60.0 {
        1
    } else if ping.unwrap() >= 150.0 || jitter >= 30.0 {
        2
    } else {
        3
    };
    let status = if !connected {
        "未接続"
    } else {
        ["未計測", "不安定", "普通", "良好"][bars]
    };
    let title = format!(
        "音声接続：{status} ／ ping：{} ／ 受信の揺らぎ：{} ms ／ 受信ロス：{}%",
        ping.map(|n| format!("{n:.0} ms")).unwrap_or("—".into()),
        text(&quality["jitterMs"]),
        text(&quality["lossPercent"])
    );
    format!(
        "<span class=quality role=img tabindex=0 aria-label=\"{}\" title=\"{}\">{}</span>",
        e(&title),
        e(&title),
        (1..=3)
            .map(|bar| format!(
                "<i style=\"height:{}px;background:{}\"></i>",
                3 + bar * 3,
                if bar <= bars {
                    ["#72777d", "#ef5350", "#ffca28", "#66bb6a"][bars]
                } else {
                    "#72777d"
                }
            ))
            .collect::<String>()
    )
}
fn role_label(player: &Value) -> String {
    if let Some(name) = player["snrRole"]["role"]["name"].as_str() {
        return name.into();
    }
    for source in [&player["nosRole"], &player["snrRole"], &player["tohRole"]] {
        for key in ["displayName", "roleName", "name"] {
            if let Some(name) = source[key].as_str() {
                return name.into();
            }
        }
    }
    String::new()
}
pub fn main_view(s: &State) -> String {
    use crate::chrome::{footer, icon, icon_button, player_grid};
    let game = s.effective_game();
    let snapshot = s.snapshot();
    let access = s.voice["status"]["accessStatus"].as_str().unwrap_or("");
    if ["checking", "banned", "unavailable"].contains(&access) {
        let message = match access {
            "banned" => "このユーザーはBANされているため、アプリを使用できません。",
            "checking" => "ユーザーの利用状態を確認しています…",
            _ => "利用状態を確認できません。ネットワーク接続を確認してください。",
        };
        return format!("<div class=access-gate>{message}</div>");
    }
    if game.is_null() {
        let platforms = &s.result["platforms"];
        let selected = platforms
            .get(s.settings["launchPlatform"].as_str().unwrap_or(""))
            .filter(|p| p.is_object())
            .or_else(|| platforms.as_object().and_then(|p| p.values().next()));
        let launch=selected.map(|p|{let key=p["translateKey"].as_str().unwrap_or("");let name=if p["default"]==true{s.t(key)}else{key.into()};format!("<div class=launch-group><button class=launch-primary data-action=launch-game>{}</button><button class=launch-dropdown data-action=toggle-launch aria-label=起動先を選ぶ>{}</button>{}</div>",e(&name),icon("ArrowDropDown"),if s.form["launchMenu"]==true{let mut items=platforms.as_object().into_iter().flatten().map(|(id,p)|format!("<button data-action=select-launch data-value=\"{}\">{}</button>",e(id),e(&if p["default"]==true{s.t(p["translateKey"].as_str().unwrap_or(""))}else{text(&p["translateKey"])}))).collect::<String>();items.push_str("<button data-action=new-platform>カスタム起動先を追加</button>");format!("<div class=\"popup-menu launch-menu\">{items}</div>")}else{String::new()} )}).unwrap_or_else(||format!("<button class=launch-primary disabled>{}</button>",e(&s.t("game.error_platform"))));
        let content = if s.error.is_empty() {
            format!("<span class=waiting-label>{}</span><div class=spinner></div><span class=open-message>{}</span>{launch}",e(&s.t("game.waiting")),e(&s.t("game.open")))
        } else {
            format!(
                "<div class=menu-error><h3>{}</h3><p>{}</p></div>",
                e(&s.t("game.error")),
                e(&s.error)
            )
        };
        return format!("<div class=electron-menu>{content}{}</div>", footer(s));
    }
    let local = game["players"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["isLocal"] == true));
    let lobby = game["lobbyCode"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && s != "MENU")
        && !matches!(game["gameState"].as_i64(), Some(3) | Some(4));
    let code = if !lobby {
        s.t("game.menu")
    } else if s.settings["hideCode"] == true {
        "LOBBY".into()
    } else {
        text(&game["lobbyCode"])
    };
    let error = if !s.error.is_empty() {
        s.error.clone()
    } else {
        text(&s.voice["status"]["error"])
    };
    let my_avatar = if lobby {
        local
            .map(|p| format!("<div class=local-avatar>{}</div>", avatar(s, p)))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let name = local
        .map(|p| {
            p["appearanceName"]
                .as_str()
                .filter(|n| !n.is_empty())
                .unwrap_or(p["name"].as_str().unwrap_or(""))
        })
        .unwrap_or("");
    let muted = s.voice["muted"] == true || s.voice["deafened"] == true;
    let deafened = s.voice["deafened"] == true;
    let top=format!("<div class=voice-top>{my_avatar}<div class=voice-identity><div><span class=username>{}</span><button class=\"lobby-code {}\" data-action=copy-code>{}</button></div>{}</div></div>",if lobby{e(name)}else{String::new()},if lobby{"in-lobby"}else{""},e(&code),if lobby{format!("<div class=mute-buttons>{}{}</div>",icon_button("mute",if muted{"MicOff"}else{"Mic"},"マイクのミュートを切り替え",""),icon_button("deafen",if deafened{"VolumeOff"}else{"VolumeUp"},"スピーカーのミュートを切り替え",""))}else{String::new()});
    let mut others: Vec<_> = game["players"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["isLocal"] != true)
        .collect();
    let grouped = s.settings["appPlayerLayout"] == "aliveAboveGhosts";
    let is_dead = |p: &&Value| snapshot["otherDead"][text(&p["clientId"])] == true;
    if grouped {
        others.sort_by_key(is_dead);
    }
    let alive = others.iter().filter(|p| !is_dead(p)).count();
    let available = s.grid_size.unwrap_or([
        (s.viewport[0] - if grouped { 32.0 } else { 24.0 }).max(0.0),
        (s.viewport[1] - 207.0).max(0.0),
    ]);
    let (columns, size) = player_grid(
        available[0],
        available[1],
        others.len(),
        grouped.then_some(alive),
    );
    let ghost_header = if alive > 0 {
        alive.div_ceil(columns) + 2
    } else {
        1
    };
    let mut avatars = String::new();
    if grouped {
        for (dead, count, row, label, color) in [
            (false, alive, 1, "settings.app_layout.survivors", "#91d6a9"),
            (
                true,
                others.len() - alive,
                ghost_header,
                "settings.app_layout.afterlife",
                "#c8b1df",
            ),
        ] {
            if count > 0 {
                let _ = dead;
                avatars.push_str(&format!("<div class=player-group style=\"grid-row:{row};color:{color}\"><span>{}</span><i></i></div>",e(&s.t(label))));
            }
        }
    }
    for (index, p) in others.iter().enumerate() {
        let html = avatar(s, p);
        if grouped {
            let ghost = index >= alive;
            let i = if ghost { index - alive } else { index };
            avatars.push_str(&format!(
                "<div class=player-slot style=\"grid-column:{};grid-row:{}\">{html}</div>",
                i % columns + 1,
                i / columns + if ghost { ghost_header + 1 } else { 2 }
            ));
        } else {
            avatars.push_str(&format!("<div class=player-slot>{html}</div>"));
        }
    }
    let popup=s.form["playerPopup"].as_str().and_then(|id|others.iter().find(|p|text(&p["clientId"])==id)).map(|p|format!("<aside class=player-popup role=dialog aria-label=プレイヤー音量 style=\"left:{}px;top:{}px\"><strong>{}</strong>{}</aside>",s.form["popupLeft"].as_f64().unwrap_or(12.0),s.form["popupTop"].as_f64().unwrap_or(150.0),e(&text(&p["name"])),player_control(s,p))).unwrap_or_default();

    let mut grid_rows = String::new();
    if grouped {
        let mut rows = vec![];
        for count in [alive, others.len() - alive] {
            if count > 0 {
                rows.push(format!(
                    "18px repeat({},{}px)",
                    count.div_ceil(columns),
                    size + 6
                ));
            }
        }
        grid_rows = format!("grid-template-rows:{};", rows.join(" "));
    }
    let grid = if lobby && local.is_some() {
        format!("<div id=other-players-grid class=\"player-grid {}\" style=\"--avatar-size:{size}px;{grid_rows}grid-template-columns:repeat({columns},{});grid-auto-rows:{}px\">{avatars}</div>",if grouped{"grouped"}else{""},if grouped{"minmax(0,1fr)".into()}else{format!("{}px",size+6)},size+6)
    } else {
        format!(
            "<div class=public-lobbies>{}</div>",
            button("open-lobbies", &s.t("buttons.public_lobby"))
        )
    };
    let warning = text(&snapshot["versionWarning"]);
    let mod_name = text(&game["mod"]);
    let mod_badge = if mod_name == "NONE" || mod_name.is_empty() {
        String::new()
    } else {
        let label = crate::state::data()["modLabels"][&mod_name]
            .as_str()
            .unwrap_or(&mod_name);
        format!("<span class=detected-mod>MOD: {}</span>", e(label))
    };
    let content = if error.is_empty() {
        format!("{top}<div class=voice-divider></div>{grid}")
    } else {
        format!(
            "<div class=voice-error><h3>ERROR</h3><p>{}</p></div>",
            e(&error)
        )
    };
    format!("<div class=electron-voice><div class=voice-content>{mod_badge}{content}{}{popup}</div>{}</div>",if warning.is_empty(){String::new()}else{format!("<p class=notice>{}</p>",e(&warning))},footer(s))
}
fn player_control(s: &State, player: &Value) -> String {
    let id = text(&player["playerConfigId"]);
    let current = &s.settings["playerConfigMap"][&id];
    let client = e(&text(&player["clientId"]));
    let volume = current["volume"].as_f64().unwrap_or(1.0) * 100.0;
    let muted = current["isMuted"] == true;
    format!("<div class=player-popup-control><label class=icon-toggle title=ミュート><input type=checkbox data-player-mute=\"{client}\" {} aria-label=ミュート>{}</label><div class=range><input type=range min=0 max=200 step=2 value={volume} data-player-volume=\"{client}\" aria-label=音量 {}><output>{}</output></div></div>",if muted{"checked"}else{""},crate::chrome::icon(if muted{"VolumeOff"}else{"VolumeUp"}),if muted{"disabled"}else{""},if muted{"ミュート".into()}else{format!("{volume:.0}%")})
}
pub fn player_controls(s: &State) -> String {
    let mut result = String::new();
    for player in s.effective_game()["players"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["isLocal"] != true)
    {
        let id = text(&player["playerConfigId"]);
        let current = &s.settings["playerConfigMap"][&id];
        let client = text(&player["clientId"]);
        result.push_str(&format!("<div class=player-control>{}<div><strong>{}</strong><label>音量 <input type=range min=0 max=200 step=1 value={} data-player-volume=\"{}\"><output>{}%</output></label><label>ミュート <input type=checkbox data-player-mute=\"{}\" {}></label></div></div>",avatar(s,player),e(&text(&player["name"])),current["volume"].as_f64().unwrap_or(1.0)*100.0,e(&client),current["volume"].as_f64().unwrap_or(1.0)*100.0,e(&client),if current["isMuted"]==true{"checked"}else{""}));
    }
    if result.is_empty() {
        "<p>同じロビーのプレイヤーがここに表示されます。</p>".into()
    } else {
        result
    }
}
pub fn inquiry(s: &State) -> String {
    let mut attachments = String::new();
    for (index, item) in s.form["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        attachments.push_str(&format!(
            "<p>{} <button data-action=remove-attachment data-value={index}>削除</button></p>",
            e(&text(&item["name"]))
        ));
    }
    let tags = [("question", "質問"), ("bug", "不具合"), ("request", "要望")]
        .iter()
        .map(|(id, label)| {
            format!(
                "<option value={id} {}>{label}</option>",
                if s.form["tag"] == *id || s.form["tag"].is_null() && *id == "question" {
                    "selected"
                } else {
                    ""
                }
            )
        })
        .collect::<String>();
    let ready = s.form["publicIssueAcknowledged"] == true
        && !text(&s.form["subject"]).trim().is_empty()
        && !text(&s.form["body"]).trim().is_empty()
        && !s.busy;
    format!("<div class=inquiry-view><h3>問い合わせ</h3><div class=inquiry-fields><div class=inquiry-warning>送信すると、本文・選択した添付ファイル・自動添付されるログが公開GitHub Issueに掲載されます。個人情報や秘密情報が含まれていないか確認してください。</div><label class=inquiry-ack><input type=checkbox data-form=publicIssueAcknowledged {}>公開される内容を確認しました</label><select data-form=tag aria-label=種別>{tags}</select><div class=outlined-field><input id=inquiry-subject data-form=subject maxlength=100 placeholder=\" \" value=\"{}\"><label for=inquiry-subject>件名 *</label></div><div class=outlined-field><textarea id=inquiry-body data-form=body maxlength=1800 rows=6 placeholder=\" \">{}</textarea><label for=inquiry-body>本文 *</label></div><div class=inquiry-attachments>{}{attachments}</div><div id=status-message role=status>{}</div></div><div class=inquiry-actions>{}</div></div>",if s.form["publicIssueAcknowledged"]==true{"checked"}else{""},e(&text(&s.form["subject"])),e(&text(&s.form["body"])),button("inquiry-attachments","添付ファイルを選択"),e(&s.notice()),button("submit-inquiry",if s.busy{"送信中…"}else{"送信"}).replace("type=button",if ready{"type=button class=contained-danger"}else{"type=button disabled"}))
}
pub fn lobbies(s: &State) -> String {
    let mut rows = String::new();
    let query = text(&s.form["lobbySearch"]).to_lowercase();
    let mut lobbies: Vec<_> = s.result["lobbyBrowser"]["lobbies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            ["title", "host", "mods", "language"]
                .iter()
                .any(|key| text(&row[key]).to_lowercase().contains(&query))
        })
        .collect();
    lobbies.sort_by_key(|row| {
        (
            row["gameState"] != 0,
            row["current_players"].as_u64() == row["max_players"].as_u64(),
            std::cmp::Reverse(row["current_players"].as_u64().unwrap_or(0)),
        )
    });
    for lobby in lobbies {
        let available = lobby["gameState"] == 0
            && lobby["current_players"].as_u64() < lobby["max_players"].as_u64()
            && lobby["mods"].as_str().unwrap_or("NONE")
                == s.effective_game()["mod"].as_str().unwrap_or("NONE");
        let elapsed = lobby["stateTime"]
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|start| {
                let seconds = ((js_sys::Date::now() - start).max(0.0) / 1000.0) as u64;
                format!(" {:02}:{:02}", seconds / 60, seconds % 60)
            })
            .unwrap_or_default();
        rows.push_str(&format!("<tr><td>{}</td><td>{}</td><td>{}/{}</td><td>{}</td><td>{}</td><td>{}{elapsed}</td><td><button data-action=lobby-code data-value=\"{}\" {}>Show code</button></td></tr>",e(&text(&lobby["title"])),e(&text(&lobby["host"])),e(&text(&lobby["current_players"])),e(&text(&lobby["max_players"])),e(&text(&lobby["mods"])),e(crate::state::data()["languages"][text(&lobby["language"])].as_str().unwrap_or("English")),if lobby["gameState"]==0{"Lobby"}else{"In game"},e(&text(&lobby["id"])),if available{""}else{"disabled"}));
    }
    let code=s.form["lobbyCode"].as_str().filter(|v|!v.is_empty()).map(|v|format!("<div class=modal-backdrop><div class=modal role=dialog><h3>Lobby information</h3><p>{}</p><div class=modal-actions>{}</div></div></div>",e(v),button("close-lobby-code",&s.t("buttons.close")))).unwrap_or_default();
    format!("<main class=lobby-panel><b>{}</b><div class=lobby-table-wrap><table><thead><tr><th>{}</th><th>{}</th><th>{}</th><th>{}</th><th>{}</th><th>Status</th><th></th></tr></thead><tbody>{rows}</tbody></table></div><p id=status-message>{}</p>{code}</main>",e(&s.t("lobbybrowser.header")),e(&s.t("lobbybrowser.list.title")),e(&s.t("lobbybrowser.list.host")),e(&s.t("lobbybrowser.list.players")),e(&s.t("lobbybrowser.list.mods")),e(&s.t("lobbybrowser.list.language")),e(&text(&s.result["lobbyBrowser"]["error"])))
}
pub fn debug(s: &State) -> String {
    let game = s.effective_game();
    let mode = game["mod"].as_str().unwrap_or("取得待ち");
    let count = game["players"].as_array().map(Vec::len).unwrap_or(0);
    let phase = match game["gameState"].as_u64() {
        Some(0) => "LOBBY",
        Some(1) => "TASKS",
        Some(2) => "DISCUSSION",
        Some(3) => "MENU",
        _ => "取得待ち",
    };
    let mut panels = String::new();
    let dump = |v: &Value| {
        format!(
            "<pre>{}</pre>",
            e(&serde_json::to_string_pretty(v).unwrap_or_default())
        )
    };
    let mut sections = vec![];
    if mode == "NoS" {
        sections.push(("nos","NoS：コスチューム・無線・LoadedContents.json",dump(&json!({"contents":game["nosLoadedContents"],"radios":s.snapshot()["nosRadiosByPlayer"]}))));
    }
    if mode == "SUPER_NEW_ROLES" {
        sections.push((
            "snr",
            "SNR：役職・割り当て陣営・勝利陣営",
            dump(&game["players"]),
        ));
    }
    sections.extend([("appearance","プレイヤーの外見・サイズ・座標など",dump(&game["players"])),("bans","ユーザーBAN管理",bans(s,false)),("game","ゲーム状態（JSON）",dump(game)),("voice","音声接続（JSON）",dump(&s.voice)),("logs","ログ",format!("<p class=hint>最新のログ（最大64KB）を1秒ごとに更新します。</p><pre id=debug-log>{}</pre>",e(&text(&s.result["logs"]))))]);
    for (id, title, content) in sections {
        panels.push_str(&format!("<details class=debug-accordion data-debug-section={id} {}><summary>{title}</summary><div>{content}</div></details>",if s.form["debugSections"][id]==true{"open"}else{""}));
    }
    format!("<main class=debug-panel><div class=debug-toolbar><span>起動中のMOD: {} ／ ゲーム: {phase} ／ {count}人</span>{}</div><p class=debug-caption>ゲーム・音声の状態を自動更新します。詳しい情報は下の項目を開いて確認できます。</p><div class=debug-player-panel><h3>プレイヤー・役職情報</h3><input data-form=debugSearch placeholder=プレイヤー名・ID・衣装で検索 value=\"{}\"><div id=debug-player-list>{}</div></div><div class=debug-accordions>{panels}</div><div id=status-message>{}</div></main>",e(if mode=="NONE"{"Vanilla"}else{mode}),button("save-logs","ログを保存"),e(&text(&s.form["debugSearch"])),debug_players(s),e(&s.notice()))
}
pub fn debug_players(s: &State) -> String {
    let query = text(&s.form["debugSearch"]).trim().to_lowercase();
    let mut result = String::new();
    for player in s.effective_game()["players"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            [
                "name",
                "id",
                "hatId",
                "skinId",
                "visorId",
                "appearanceHatId",
                "appearanceSkinId",
                "appearanceVisorId",
            ]
            .iter()
            .any(|key| text(&p[key]).to_lowercase().contains(&query))
        })
    {
        let id = text(&player["id"]);
        result.push_str(&format!("<details data-debug-open=\"{}\" {}><summary>{} ／ ID: {} ／ {} ／ {}</summary><div class=debug-player>{}<div><p>座標: {} / {} ／ 状態: {}{}</p><p>本体陣営値: {} ／ 役職: {}</p><p>外見: 色 {} → {} ／ Outfit {}</p><h4>Mod役職・能力・衣装</h4><pre>{}</pre><h4>無線</h4><pre>{}</pre></div></div></details>",e(&id),if s.form["debugExpanded"][&id]==true{"open"}else{""},e(&text(&player["name"])),e(&id),e(&role_label(player)),if player["isLocal"]==true{"自分"}else{"他プレイヤー"},avatar(s,player),e(&text(&player["x"])),e(&text(&player["y"])),if player["disconnected"]==true{"切断"}else if player["isDead"]==true{"死亡"}else{"生存"},if player["inVent"]==true{" / ベント"}else{""},e(&text(&player["roleTeam"])),e(&text(&player["roleName"])),e(&text(&player["colorId"])),e(&text(&player["appearanceColorId"])),e(&text(&player["currentOutfit"])),e(&serde_json::to_string_pretty(player).unwrap_or_default()),e(&serde_json::to_string_pretty(&if player["isLocal"]==true{s.effective_game()["nosRadios"].clone()}else{s.snapshot()["nosRadiosByPlayer"][&id].clone()}).unwrap_or_default())));
    }
    result
}
fn ban_flag(value: &Value) -> bool {
    value == true || value.as_i64().is_some_and(|n| n != 0)
}
pub fn bans(s: &State, history: bool) -> String {
    let data = &s.result["bans"];
    let ip = s.form["banType"] == "ip" && data["ipBansAvailable"] == true;
    let disabled = if s.busy { " disabled" } else { "" };
    let field = |key: &str| e(&text(&s.form[key]));
    let mut content=format!("<section><h3>{}</h3><div class=form-grid><label>BAN管理者パスワード<input type=password data-form=banPassword autocomplete=off value=\"{}\"></label><label>登録理由<input data-form=banReason maxlength=500 value=\"{}\"></label><label>BANの種類<select data-form=banType><option value=uid {}>UID</option><option value=ip {} {}>IP</option></select></label><label>プレイヤー名<input data-form=banName maxlength=80 value=\"{}\"></label>",if history{"プレイヤー履歴"}else{"BAN管理"},field("banPassword"),field("banReason"),if ip{""}else{"selected"},if ip{"selected"}else{""},if data["ipBansAvailable"]==true{""}else{"disabled"},field("banName"));
    if history {
        content.push_str(&format!("<label>開始日<input type=date data-form=historyFrom value=\"{}\"></label><label>終了日<input type=date data-form=historyTo value=\"{}\"></label>",field("historyFrom"),field("historyTo")));
    }
    content.push_str(
        &button(
            "ban-list",
            if history {
                "検索"
            } else {
                "一覧を読み込む"
            },
        )
        .replace(
            "type=button",
            if s.busy {
                "type=button disabled"
            } else {
                "type=button"
            },
        ),
    );
    if !history {
        content.push_str(&button("ban-name", "名前で予約する"));
        content.push_str(
            "<p class=hint>名前による予約は、先に接続した同名プレイヤーのUIDに適用されます。</p>",
        );
    }
    content.push_str("</div>");
    if !history {
        content.push_str("<h3>現在のロビー</h3>");
        for player in s.effective_game()["players"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["playerUid"].as_str().is_some_and(|v| !v.is_empty()))
        {
            content.push_str(&format!("<p>{} ／ Friend Code: {} <button data-action=ban-player data-value=\"{}\" data-player-uid=\"{}\"{disabled}>BAN登録</button></p>",e(&text(&player["name"])),e(&text(&player["friendCode"])),e(&text(&player["clientId"])),e(&text(&player["playerUid"]))));
        }
        content.push_str("<h3>UID待ち</h3>");
        for record in data["pending"].as_array().into_iter().flatten() {
            content.push_str(&format!("<p>{} ／ {} <button data-action=ban-remove-name data-value=\"{}\"{disabled}>解除</button></p>",e(&text(&record["player_name"])),e(&text(&record["reason"])),e(&text(&record["player_name"]))));
        }
        content.push_str("<h3>登録済み</h3>");
        for record in data["bans"].as_array().into_iter().flatten() {
            let ip = record["ban_type"] == "ip";
            let id = &record[if ip { "public_ip" } else { "uid_digest" }];
            content.push_str(&format!("<p>{} ／ {} BAN ／ UID: {} ／ IP: {} ／ {} <button data-action=ban-record data-value=\"{}\" data-ban-type={} data-history=false{disabled}>解除</button></p>",e(&text(&record["display_name"])),if ip{"IP"}else{"UID"},e(&text(&record["player_uid"])),e(&text(&record["public_ip"])),e(&text(&record["reason"])),e(&text(id)),if ip{"ip"}else{"uid"}));
        }
    }
    content.push_str(&format!(
        "<h3>登録済みプレイヤー（{}人）</h3>",
        data["historyTotal"].as_u64().unwrap_or(0)
    ));
    if data["historyAvailable"] == false {
        content.push_str("<p>履歴機能はサーバーに未反映です。</p>");
    }
    if data["ipBansAvailable"] == false {
        content.push_str("<p class=hint>IP BANはサーバーに未反映です。</p>");
    }
    for record in data["history"].as_array().into_iter().flatten() {
        let uid_banned = if record["uid_banned"].is_null() {
            ban_flag(&record["is_banned"])
        } else {
            ban_flag(&record["uid_banned"])
        };
        let banned = if ip {
            ban_flag(&record["ip_banned"])
        } else {
            uid_banned
        };
        content.push_str(&format!("<div class=history-record><p>{} ／ Friend Code: {} ／ IP: {}</p><p class=hint>初回: {} ／ 最終: {} ／ UID: {} ／ IP: {}</p>{}</div>",e(&text(&record["display_name"])),e(&text(&record["friend_code"])),e(&text(&record["public_ip"])),e(&seen_at(&record["first_seen_at"])),e(&seen_at(&record["last_seen_at"])),if uid_banned{"BAN済み"}else{"未BAN"},if ban_flag(&record["ip_banned"]){"BAN済み"}else{"未BAN"},if banned{"<span>BAN済み</span>".into()}else{format!("<button data-action=ban-record data-value=\"{}\" data-history=true {}> {}でBAN登録</button>",e(&text(&record["uid_digest"])),if s.busy||ip&&record["public_ip"].as_str().is_none_or(|s|s.is_empty()){"disabled"}else{""},if ip{"IP"}else{"UID"})}));
    }
    if history {
        let offset = s.form["historyOffset"].as_u64().unwrap_or(0);
        let total = data["historyTotal"].as_u64().unwrap_or(0);
        content.push_str(&format!("<div><button data-action=history-previous {}>前へ</button> {}–{} / {} <button data-action=history-next {}>次へ</button></div>",if s.busy||offset==0{"disabled"}else{""},if total==0{0}else{offset+1},(offset+50).min(total),total,if s.busy||offset+50>=total{"disabled"}else{""}));
    }
    content.push_str(&format!(
        "<p id=status-message>{}</p></section>",
        e(&s.notice())
    ));
    content
}
fn seen_at(value: &Value) -> String {
    let Some(timestamp) = value.as_f64() else {
        return text(value);
    };
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(timestamp * 1000.0));
    format!(
        "{:04}/{:02}/{:02} {:02}:{:02}",
        date.get_full_year(),
        date.get_month() + 1,
        date.get_date(),
        date.get_hours(),
        date.get_minutes()
    )
}
pub fn body(s: &State) -> String {
    match s.view.as_str() {
        "settings" => crate::settings::render(s),
        "lobbies" => lobbies(s),
        "debug" => debug(s),
        "player-history" => format!("<main class=history-panel><h2>過去に同じロビーで確認したプレイヤー</h2><p class=hint>初回・最終日時は、アプリが同じロビーで確認した時刻です。日付検索は最終確認日を対象にします。</p>{}</main>", bans(s, true)),
        "overlay" => crate::overlay::render(s),
        _ => main_view(s),
    }
}
