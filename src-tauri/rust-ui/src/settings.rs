use crate::state::{at, data, escaped as e, text, State};
use serde_json::{json, Value};
pub const CATEGORIES: [(&str, &str); 12] = [
    ("general", "settings.general"),
    ("appLayout", "settings.app_layout.title"),
    ("lobby", "settings.lobbysettings.title"),
    ("players", "settings.players.title"),
    ("audio", "settings.audio.title"),
    ("voiceEffects", "settings.voice_effects.title"),
    ("keybinds", "settings.keyboard.title"),
    ("overlay", "settings.overlay.title"),
    ("advanced", "settings.advanced.title"),
    ("update", "アップデート"),
    ("streaming", "settings.streaming.title"),
    ("inquiry", "問い合わせ"),
];
pub fn button(action: &str, label: &str) -> String {
    format!(
        "<button type=button data-action=\"{}\">{}</button>",
        e(action),
        e(label)
    )
}
fn options(s: &State, key: &str) -> Vec<(Value, String)> {
    let pairs = |items: &[(&str, &str)]| {
        items
            .iter()
            .map(|(v, label)| (json!(v), s.t(label)))
            .collect()
    };
    match key {
        "language" => data()["languageOrder"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(|v| {
                (
                    json!(v),
                    data()["languages"][v].as_str().unwrap_or(v).to_owned(),
                )
            })
            .collect(),
        "microphone" | "speaker" => {
            let mut values = vec![(json!("default"), s.t("buttons.default"))];
            for device in s.devices[if key == "microphone" {
                "inputs"
            } else {
                "outputs"
            }]
            .as_array()
            .into_iter()
            .flatten()
            {
                values.push((device["id"].clone(), text(&device["name"])));
            }
            values
        }
        "pushToTalkMode" => [
            "settings.audio.voice_activity",
            "settings.audio.push_to_talk",
            "settings.audio.push_to_mute",
        ]
        .iter()
        .enumerate()
        .map(|(i, label)| (json!(i), s.t(label)))
        .collect(),
        "appPlayerLayout" => pairs(&[
            ("standard", "settings.app_layout.standard"),
            ("aliveAboveGhosts", "settings.app_layout.alive_above_ghosts"),
        ]),
        "overlayPosition" => [
            "hidden",
            "top",
            "bottom_left",
            "right",
            "right1",
            "left",
            "left1",
        ]
        .iter()
        .map(|v| {
            (
                json!(v),
                s.t(&format!(
                    "settings.overlay.locations.{}",
                    if *v == "bottom_left" { "bottom" } else { v }
                )),
            )
        })
        .collect(),
        "myLobbySettings.nosGluttonySwallowVoice" => ["mute", "quiet", "normal"]
            .iter()
            .map(|v| {
                (
                    json!(v),
                    s.t(&format!(
                        "settings.lobbysettings.nos_gluttony_swallow_voice_{v}"
                    )),
                )
            })
            .collect(),
        "launchPlatform" => {
            let mut result = Vec::new();
            for source in [
                &data()["constants"]["DefaultGamePlatforms"],
                &s.settings["customPlatforms"],
            ] {
                if let Some(items) = source.as_object() {
                    for (id, value) in items {
                        result.push((json!(id), value["name"].as_str().unwrap_or(id).to_owned()));
                    }
                }
            }
            result
        }
        "serverURL" => s.settings["serverURLs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(|v| (json!(v), v.to_owned())))
            .collect(),
        "myLobbySettings.publicLobby_language" => data()["languageOrder"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(|v| {
                (
                    json!(v),
                    data()["languages"][v].as_str().unwrap_or(v).to_owned(),
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}
pub fn display_number(format: &str, n: f64) -> String {
    match format {
        "percent" => format!("{n:.0}%"),
        "fixed2" => format!("{n:.2}"),
        "fixed1" => format!("{n:.1}"),
        _ => format!("{n:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned(),
    }
}
pub fn row(
    s: &State,
    key: &str,
    label: &str,
    description: &str,
    range: (f64, f64, f64),
    disabled: bool,
) -> String {
    let value = at(&s.settings, key);
    let choices = options(s, key);
    let disabled = if disabled { " disabled" } else { "" };
    let id = format!("setting-{}", key.replace('.', "-"));
    let control = if value.is_boolean() {
        format!(
            "<input id=\"{id}\" type=checkbox role=switch data-setting=\"{}\" {}{disabled}>",
            e(key),
            if (value == true) ^ (key == "hideCode") {
                "checked"
            } else {
                ""
            }
        )
    } else if !choices.is_empty() {
        let selected = text(value).to_ascii_lowercase();
        format!(
            "<select id=\"{id}\" data-setting=\"{}\"{disabled}>{}</select>",
            e(key),
            choices
                .iter()
                .map(|(v, label)| format!(
                    "<option value=\"{}\" {}>{}</option>",
                    e(&text(v)),
                    if text(v).to_ascii_lowercase() == selected {
                        "selected"
                    } else {
                        ""
                    },
                    e(label)
                ))
                .collect::<String>()
        )
    } else if value.is_number() {
        let number = value.as_f64().unwrap_or(0.0);
        let number = if key == "micSensitivity" {
            1.0 - number
        } else {
            number
        };
        let display = format!("{number:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned();
        let unit = if [
            "microphoneGain",
            "masterVolume",
            "crewVolumeAsGhost",
            "ghostVolumeAsImpostor",
            "rokuroVoice.headVolume",
            "rokuroVoice.bodyVolume",
            "rokuroVoice.bodyEcho",
        ]
        .contains(&key)
        {
            "percent"
        } else if key == "micSensitivity" {
            "fixed2"
        } else if key.ends_with("maxDistance") {
            "fixed1"
        } else {
            "number"
        };
        format!("<div class=range><input id=\"{id}\" type=range min={} max={} step={} value={} data-format={unit} data-setting=\"{}\"{disabled}><output>{}</output></div>",range.0,range.1,range.2,display,e(key),display_number(unit,number))
    } else if key == "serverURL" {
        format!("<div><input id=\"{id}\" type=text data-setting=serverURL value=\"{}\" list=voice-servers><datalist id=voice-servers data-setting-list=serverURLs>{}</datalist></div>",e(&text(value)),choices.iter().map(|(v,_)|format!("<option value=\"{}\"></option>",e(&text(v)))).collect::<String>())
    } else {
        format!(
            "<input id=\"{id}\" type=text value=\"{}\" data-setting=\"{}\"{disabled} {}>",
            e(&text(value)),
            e(key),
            if key.ends_with("Shortcut") {
                "data-key-capture=true readonly"
            } else {
                ""
            }
        )
    };
    format!("<div class=setting-row data-row=\"{}\"><div><label for=\"{id}\">{}</label><p class=hint>{}</p></div><div class=\"setting-control{}\">{control}</div></div>",e(key),e(label),e(description),if value.is_boolean(){" switch-control"}else{""})
}
fn extra(key: &str) -> Option<(&'static str, &'static str)> {
    Some(match key {
        "pushToTalkMode" => ("audio", "settings.audio.mode"),
        "microphoneGainEnabled" => ("audio", "マイク音量の調整を有効にする"),
        "micSensitivityEnabled" => ("audio", "マイク感度の調整を有効にする"),
        "pushToTalkShortcut" => ("keybinds", "settings.keyboard.push_to_talk"),
        "impostorRadioShortcut" => ("keybinds", "settings.keyboard.impostor_radio"),
        "jackalRadioShortcut" => ("keybinds", "ジャッカル無線（NoS）"),
        "muteShortcut" => ("keybinds", "settings.keyboard.mute"),
        "deafenShortcut" => ("keybinds", "settings.keyboard.deafen"),
        "launchPlatform" => ("advanced", "ゲームの起動先"),
        "myLobbySettings.impostorRadioOnlyMode" => {
            ("lobby", "settings.lobbysettings.impostor_radio_only")
        }
        "myLobbySettings.tohNeutralKillerHaunting" => (
            "lobby",
            "settings.lobbysettings.toh_neutral_killer_haunting",
        ),
        "myLobbySettings.publicLobby_title" => ("lobby", "公開ロビーのタイトル"),
        _ => return None,
    })
}
fn camel_snake(value: &str) -> String {
    let mut result = String::new();
    for c in value.chars() {
        if c.is_ascii_uppercase() {
            result.push('_');
            result.push(c.to_ascii_lowercase());
        } else {
            result.push(c);
        }
    }
    result
}
fn automatic_label(s: &State, key: &str) -> String {
    let name = key.rsplit('.').next().unwrap_or(key);
    if let Some(effect) = EFFECTS.iter().find(|effect| effect.1 == name) {
        return format!(
            "{} — {}",
            s.t(effect.2),
            s.t("settings.lobbysettings.effect_strength")
        );
    }
    let label = s.t(&format!("settings.lobbysettings.{}", camel_snake(name)));
    if !label.starts_with("settings.") {
        return label;
    }
    if name.ends_with("Strength") {
        return format!(
            "{} — {}",
            name.trim_end_matches("Strength").replace("VoiceEffect", ""),
            s.t("settings.lobbysettings.effect_strength")
        );
    }
    name.into()
}
pub fn section(title: &str, content: String) -> String {
    format!(
        "<section class=settings-section>{}<div class=settings-paper>{content}</div></section>",
        if title.is_empty() {
            String::new()
        } else {
            format!("<div class=section-title>{}</div>", e(title))
        }
    )
}
fn key_row(s: &State, key: &str) -> String {
    let descriptor = data()["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["key"] == key);
    let label = descriptor
        .map(|d| s.t(d["label"].as_str().unwrap_or("")))
        .or_else(|| extra(key).map(|(_, l)| s.t(l)))
        .unwrap_or_else(|| automatic_label(s, key));
    let description = descriptor
        .and_then(|d| d["description"].as_str())
        .map(|d| s.t(d))
        .unwrap_or_default();
    let defaults = if key.ends_with("maxDistance") {
        (1.0, 10.0, 0.1)
    } else if key == "micSensitivity" {
        (0.0, 1.0, 0.05)
    } else if key == "microphoneGain" {
        (0.0, 300.0, 2.0)
    } else {
        (0.0, if key == "masterVolume" { 200.0 } else { 100.0 }, 1.0)
    };
    let range = descriptor
        .map(|d| {
            (
                d["min"].as_f64().unwrap_or(defaults.0),
                d["max"].as_f64().unwrap_or(defaults.1),
                d["step"].as_f64().unwrap_or(defaults.2),
            )
        })
        .unwrap_or(defaults);
    let label = if key == "myLobbySettings.maxDistance" {
        s.t(if s.settings["myLobbySettings"]["visionHearing"] == true {
            "settings.lobbysettings.voicedistance_impostor"
        } else {
            "settings.lobbysettings.voicedistance"
        })
    } else {
        label
    };
    row(
        s,
        key,
        &label,
        &description,
        range,
        (s.host_in_match() && key.starts_with("myLobbySettings."))
            || s.form["lobbyReadOnly"] == true
            || radio_forced(s, key)
            || key == "oldSampleDebug"
            || (["compactOverlay", "meetingOverlay", "overlayPosition"].contains(&key)
                && s.settings["enableOverlay"] != true),
    )
}
fn key_section(s: &State, title: &str, keys: &[&str]) -> String {
    section(
        &s.t(title),
        keys.iter().map(|key| key_row(s, key)).collect(),
    )
}
fn audio(s: &State) -> String {
    let mut devices = String::new();
    for key in ["microphone", "speaker"] {
        let raw = key_row(s, key);
        let suffix = if key == "microphone" {
            format!("<div class=meter-shell><div id=microphone-meter class=meter><span style=\"width:{}%\"></span></div></div>",microphone_meter_level(s))
        } else {
            button(
                "speaker-test",
                &s.t(if s.form["speakerTest"] == true {
                    "settings.audio.test_speaker_stop"
                } else {
                    "settings.audio.test_speaker_start"
                }),
            )
        };
        devices.push_str(
            &raw.replace("<select ", "<div class=device-stack><select ")
                .replace("</select>", &format!("</select>{suffix}</div>")),
        );
    }
    let radio=["settings.audio.voice_activity","settings.audio.push_to_talk","settings.audio.push_to_mute"].iter().enumerate().map(|(i,k)|format!("<label><input type=radio name=voice-mode value={i} data-setting=pushToTalkMode {}>{}</label>",if s.settings["pushToTalkMode"]==i{"checked"}else{""},e(&s.t(k)))).collect::<String>();
    let mut mic = String::new();
    for (key, toggle) in [
        ("microphoneGain", "microphoneGainEnabled"),
        ("micSensitivity", "micSensitivityEnabled"),
    ] {
        let control = format!(
            "<input class=switch type=checkbox role=switch data-setting=\"{toggle}\" aria-label=\"{}\" {}>",
            e(&s.t(if key == "microphoneGain" {
                "settings.audio.microphone_volume"
            } else {
                "settings.audio.microphone_sens"
            })),
            if s.settings[toggle] == true {
                "checked"
            } else {
                ""
            }
        );
        let mut raw = key_row(s, key);
        raw = raw.replace("<div class=range>", &format!("<div class=range>{control}"));
        if s.settings[toggle] != true {
            raw = raw.replace("type=range", "type=range disabled");
        }
        mic.push_str(&raw);
    }
    format!(
        "{}{}{}{}",
        section(&s.t("settings.audio.title"), devices),
        section(
            &s.t("settings.audio.mode"),
            format!("<div class=radio-group>{radio}</div>")
        ),
        section(&s.t("settings.audio.microphone"), mic),
        key_section(
            s,
            "",
            &["masterVolume", "crewVolumeAsGhost", "ghostVolumeAsImpostor"]
        )
    )
}
pub fn microphone_meter_level(s: &State) -> f64 {
    (s.voice["microphoneRms"].as_f64().unwrap_or(0.0) * 2.0).clamp(0.0, 1.0) * 100.0
}
fn lobby(s: &State) -> String {
    let current = s.form["lobbyTab"] == "current"
        || (s.form["lobbyTab"].is_null()
            && s.effective_game()["isHost"] == false
            && s.snapshot()["activeLobbySettings"].is_object());
    let tabs = format!(
        "<div class=settings-tabs>{}</div>",
        [
            ("current", "settings.lobbysettings.tab_current"),
            ("mine", "settings.lobbysettings.tab_mine")
        ]
        .iter()
        .map(|(id, label)| format!(
            "<button class=\"{}\" data-action=lobby-tab data-value={id}>{}</button>",
            if (*id == "current") == current {
                "selected"
            } else {
                ""
            },
            e(&s.t(label))
        ))
        .collect::<String>()
    );
    if current && !s.snapshot()["activeLobbySettings"].is_object() {
        return format!(
            "{tabs}<p class=settings-alert>{}</p>",
            e(&s.t("settings.lobbysettings.no_lobby"))
        );
    }
    let mut displayed = s.clone();
    if current {
        displayed.settings["myLobbySettings"] = s.snapshot()["activeLobbySettings"].clone();
        displayed.form["lobbyReadOnly"] = json!(true);
    }
    let s = &displayed;
    let main_keys = [
        "myLobbySettings.impostorRadioOnlyMode",
        "myLobbySettings.maxDistance",
        "myLobbySettings.wallsBlockAudio",
        "myLobbySettings.visionHearing",
        "myLobbySettings.voiceEffectEnabled",
        "myLobbySettings.haunting",
        "myLobbySettings.hearImpostorsInVents",
        "myLobbySettings.impostersHearImpostersInvent",
        "myLobbySettings.commsSabotage",
        "myLobbySettings.hearThroughCameras",
        "myLobbySettings.impostorRadioEnabled",
        "myLobbySettings.deadOnly",
        "myLobbySettings.meetingGhostOnly",
    ];
    let mut content = format!(
        "{tabs}<p class=settings-alert>{}</p>{}",
        e(&s.t(if current {
            "settings.lobbysettings.host_notice"
        } else if s.host_in_match() {
            "settings.lobbysettings.inlobbyonly"
        } else {
            "settings.lobbysettings.mine_notice"
        })),
        key_section(s, "settings.lobbysettings.title", &main_keys)
    );
    let mode = s.effective_game()["mod"].as_str().unwrap_or("");
    if mode == "SUPER_NEW_ROLES" {
        content.push_str(&key_section(
            s,
            "settings.lobbysettings.snr_section",
            &[
                "myLobbySettings.snrJumboVoice",
                "myLobbySettings.snrPushReverb",
                "myLobbySettings.snrBuskerReviveHideVoice",
                "myLobbySettings.jackalHaunting",
                "myLobbySettings.jackalRadioEnabled",
                "myLobbySettings.jackalHearOutsideVents",
                "myLobbySettings.jackalTalkInVents",
                "myLobbySettings.sidekickHaunting",
                "myLobbySettings.sidekickHearOutsideVents",
                "myLobbySettings.sidekickTalkInVents",
            ],
        ));
    }
    if mode == "NoS" {
        let mut keys = vec![
            "myLobbySettings.nosSizeVoiceEffect",
            "myLobbySettings.nosRokurokubiVoiceEffect",
            "myLobbySettings.nosBerserkerVoiceEffect",
        ];
        if s.effective_game()["nosAddonIds"]
            .as_array()
            .is_some_and(|a| a.contains(&json!("UchuAddon")))
        {
            keys.extend([
                "myLobbySettings.nosCitrusVoiceEffect",
                "myLobbySettings.nosRainbowStarEcho",
                "myLobbySettings.nosGluttonySwallowVoice",
            ]);
        }
        keys.extend([
            "myLobbySettings.jackalRadioEnabled",
            "myLobbySettings.nosNeutralKillerHaunting",
            "myLobbySettings.nosBuskerReviveHideVoice",
            "myLobbySettings.nosVoicePositions",
            "myLobbySettings.nosFixerJammingVoiceBlock",
            "myLobbySettings.nosFixerJammingLowpass",
        ]);
        content.push_str(&key_section(s, "settings.lobbysettings.nos_section", &keys));
    }
    if mode == "TOH4E" {
        content.push_str(&section(
            &s.t("settings.lobbysettings.toh_section"),
            format!(
                "{}{}",
                button("toh-roles", "役職別の幽霊音声設定"),
                if s.form["tohRolesOpen"] == true {
                    toh_roles(s)
                } else {
                    String::new()
                }
            ),
        ));
    }
    let mut public = key_row(s, "myLobbySettings.publicLobby_on");
    {
        public.push_str(&key_row(s, "myLobbySettings.publicLobby_title"));
        public.push_str(&key_row(s, "myLobbySettings.publicLobby_language"));
    }
    content.push_str(&section(&s.t("buttons.public_lobby"), public));
    content
}
pub fn render(s: &State) -> String {
    let navigation=CATEGORIES.iter().enumerate().map(|(i,(id,label))|format!("<button class=\"{}\" data-action=category data-value=\"{id}\">{}<span class=nav-label>{}</span></button>",if *id==s.category{"selected"}else{""},crate::chrome::icon(["Tune","GridView","Groups","Person","VolumeUp","GraphicEq","Keyboard","Layers","Science","SystemUpdate","Videocam","ContactSupport"][i]),e(&s.t(label)))).collect::<String>();
    let content=match s.category.as_str(){
 "general"=>format!("{}{}",key_section(s,"settings.general",&["language","alwaysOnTop"]),section(&s.t("settings.troubleshooting.title"),format!("<div class=setting-row><div><label>{}</label><p class=hint>{}</p></div><div class=\"setting-control switch-control\">{}</div></div>",e(&s.t("settings.troubleshooting.restore")),e(&s.t("settings.troubleshooting.restore_warning")),button("reset-settings",&s.t("settings.troubleshooting.restore")).replace("type=button","type=button class=contained-danger")))),
 "appLayout"=>key_section(s,"settings.app_layout.title",&["appPlayerLayout"]),
 "audio"=>audio(s),"lobby"=>lobby(s),"voiceEffects"=>effects(s),
 "keybinds"=>{let mut keys=vec!["pushToTalkShortcut","impostorRadioShortcut"];if s.effective_game()["mod"]=="NoS"{keys.push("jackalRadioShortcut");}keys.extend(["muteShortcut","deafenShortcut"]);key_section(s,"settings.keyboard.title",&keys)},
 "overlay"=>key_section(s,"settings.overlay.title",&["enableOverlay","compactOverlay","meetingOverlay","overlayPosition"]),
 "players"=>section(&s.t("settings.players.title"),crate::views::player_controls(s)),
 "advanced"=>format!("{}{}{}",section(&s.t("settings.advanced.title"),format!("{}{}<div class=setting-row><div><label>{}</label><p class=hint>{}</p></div>{}</div>",key_row(s,"serverURL"),key_row(s,"natFix"),e(&s.t("settings.advanced.voice_server")),e(&text(&s.settings["serverURL"])),button("edit-server","サーバーを追加"))),section("デバッグ",format!("<div class=setting-row><div><label>デバッグ情報</label><p class=hint>ゲーム状態・音声接続・ログを別ウィンドウで表示します。</p></div>{}</div>",button("debug-dialog","デバッグ情報を開く"))),key_section(s,"settings.beta.title",&["mobileHost","hardware_acceleration","echoCancellation","autoGainControl","enableSpatialAudio","noiseSuppression","oldSampleDebug"])),
 "streaming"=>{let mut html=key_row(s,"hideCode");html.push_str(&key_row(s,"obsOverlay"));if s.settings["obsOverlay"]==true{html.push_str(&format!("<div class=row-content><label>{}</label><input readonly value=\"{}\">{}</div>",e(&s.t("settings.streaming.obs_url")),e(&obs_url(s)),button("copy-obs",&s.t("settings.streaming.copy_url"))));}section(&s.t("settings.streaming.title"),html)},
 "update"=>section("アップデート",format!("<div class=row-content><p>現在のバージョン: {}</p><p id=updater-status>{}</p>{}{}{}</div>",e(&s.version),e(&text(&s.updater["message"])),button("check-updates","更新を確認"),button("download-update","更新をダウンロード").replace("type=button",if s.updater["state"]=="available"&&!s.busy{"type=button"}else{"type=button disabled"}),button("install-update","インストーラーを起動").replace("type=button",if s.updater["state"]=="downloaded"&&!s.busy{"type=button"}else{"type=button disabled"}))),
 "inquiry"=>crate::views::inquiry(s),_=>String::new()};
    let modal = dialogs(s);
    format!("<div class=settings-layout><nav>{navigation}</nav><main id=settings-content><div class=settings-inner>{content}<div id=status-message role=status>{}</div></div></main>{modal}</div>",e(&s.notice()))
}
pub fn dialogs(s: &State) -> String {
    let close = button("close-dialog", "キャンセル");
    if s.form["debugDialog"] == true {
        return format!("<div class=modal-backdrop><div class=modal role=dialog aria-modal=true><h3>デバッグ画面の認証</h3><label>パスワード<input type=password data-form=debugPassword autocomplete=off value=\"{}\"></label><p class=hint>開発者または確認担当者用のデバッグパスワードを入力してください。</p><div class=modal-actions>{close}{}</div></div></div>",e(&text(&s.form["debugPassword"])),button("open-debug","開く"));
    }
    if s.form["serverDialog"] == true {
        return format!("<div class=modal-backdrop><div class=modal role=dialog><h3>サーバーを追加</h3><datalist id=voice-servers data-setting-list=serverURLs></datalist><input type=url data-form=serverURL value=\"{}\" placeholder=https://><div class=modal-actions>{close}{}</div></div></div>",e(&text(&s.form["serverURL"])),button("save-server","追加"));
    }
    if s.form["platformDialog"] == true {
        return platform_editor(s);
    }
    String::new()
}
fn radio_forced(s: &State, key: &str) -> bool {
    if s.settings["myLobbySettings"]["impostorRadioOnlyMode"] != true {
        return false;
    }
    let Some(key) = key.strip_prefix("myLobbySettings.") else {
        return false;
    };
    if key == "maxDistance" {
        return true;
    }
    [
        "impostorRadioEnabled",
        "meetingGhostOnly",
        "deadOnly",
        "wallsBlockAudio",
        "visionHearing",
        "voiceEffectEnabled",
        "hearImpostorsInVents",
        "impostersHearImpostersInvent",
        "commsSabotage",
        "hearThroughCameras",
        "snrJumboVoice",
        "snrPushReverb",
        "jackalHearOutsideVents",
        "jackalTalkInVents",
        "jackalRadioEnabled",
        "sidekickHearOutsideVents",
        "sidekickTalkInVents",
        "nosVoicePositions",
    ]
    .contains(&key)
}
fn toh_roles(s: &State) -> String {
    let Some(catalog) = s.snapshot()["tohRoleCatalog"].as_array() else {
        return if s.effective_game()["mod"] == "TOH4E" {
            "<p>TOH4E役職一覧の取得を待っています。</p>".into()
        } else {
            String::new()
        };
    };
    let lobby = &s.settings["myLobbySettings"];
    let disabled = if s.host_in_match() { "disabled" } else { "" };
    let mut html="<section><h3>TOH4E 幽霊の声を聞ける役職</h3><p class=hint>有効にした役職は生存中も幽霊の声を聞けます。インポスターは通常のロビー設定で変更できます。</p>".to_owned();
    for (kind, label) in [("Neutral", "第三陣営"), ("Animals", "アニマルズ")] {
        let roles: Vec<_> = catalog
            .iter()
            .filter(|role| role["customRoleType"] == kind && role["isKiller"] == true)
            .collect();
        let enabled = roles
            .iter()
            .filter(|role| {
                crate::state::toh_ghost_enabled(lobby, role["roleName"].as_str().unwrap_or(""))
            })
            .count();
        html.push_str(&format!("<h4>{label}</h4><label><input type=checkbox data-action=toh-group data-value={kind} {} {}>{label}を一括設定（{enabled} / {} 役職がオン）</label>",if !roles.is_empty()&&enabled==roles.len(){"checked"}else{""},if roles.is_empty(){"disabled"}else{disabled},roles.len()));
        for role in roles {
            let name = role["roleName"].as_str().unwrap_or("");
            html.push_str(&format!("<div class=setting-row><label>{}</label><input type=checkbox role=switch data-setting=\"myLobbySettings.tohGhostRoles.{}\" {} {disabled}></div>",e(role["displayName"].as_str().unwrap_or(name)),e(name),if crate::state::toh_ghost_enabled(lobby,name){"checked"}else{""}));
        }
    }
    html.push_str("</section>");
    html
}
fn platform_editor(s: &State) -> String {
    let field = |key: &str| e(&text(&s.form[key]));
    let exe = s.form["platformType"] != "URI";
    let radios = ["EXE", "URI"].iter().map(|kind|format!("<label><input type=radio name=platformType data-form=platformType value={kind} {}>{kind}</label>",if (*kind=="EXE")==exe{"checked"}else{""})).collect::<String>();
    let path = format!(
        "<label>{}<input data-form=platformPath value=\"{}\" {}></label>",
        e(&s.t(if exe {
            "settings.customplatforms.path"
        } else {
            "settings.customplatforms.uri"
        })),
        field("platformPath"),
        if exe { "disabled" } else { "" }
    );
    let extra = if exe {
        format!("{}<label class=platform-advanced><input type=checkbox data-form=platformAdvanced {}>{}</label>{}",button("pick-platform",&s.t("buttons.file_select")),if s.form["platformAdvanced"]==true{"checked"}else{""},e(&s.t("settings.customplatforms.advanced")),if s.form["platformAdvanced"]==true{format!("<label>{}<input data-form=platformArgs value=\"{}\"></label>",e(&s.t("settings.customplatforms.arguments")),field("platformArgs"))}else{String::new()})
    } else {
        String::new()
    };
    let remove = s.form["platformEdit"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(|id| {
            format!(
                "<button type=button data-action=remove-platform data-value=\"{}\">{}</button>",
                e(id),
                e(&s.t("buttons.delete"))
            )
        })
        .unwrap_or_default();
    format!("<div class=\"modal-backdrop platform-backdrop\"><div class=\"modal platform-editor\" role=dialog aria-modal=true><header><h3>{}</h3>{}</header><div class=platform-fields><label>{}<input data-form=platformName maxlength=80 value=\"{}\"></label><div class=voice-modes>{radios}</div>{path}{extra}</div><div class=modal-actions>{remove}{}</div></div></div>",e(&s.t("settings.customplatforms.title")),crate::chrome::icon_button("close-dialog","ArrowBack","戻る",""),e(&s.t("settings.customplatforms.platform_title")),field("platformName"),button("save-platform",&s.t("buttons.confirm")))
}
pub const EFFECTS: [(&str, &str, &str, i32, bool, bool); 11] = [
    (
        "disguise",
        "voiceEffectStrength",
        "settings.voice_effects.disguise_strength",
        -1,
        false,
        false,
    ),
    (
        "snrJumbo",
        "snrJumboVoiceEffectStrength",
        "settings.voice_effects.snr_jumbo_strength",
        -1,
        false,
        false,
    ),
    (
        "snrPush",
        "snrPushReverbStrength",
        "settings.voice_effects.snr_push_reverb_strength",
        0,
        true,
        false,
    ),
    (
        "nosSize",
        "nosSizeVoiceEffectStrength",
        "settings.voice_effects.nos_size_strength",
        -1,
        false,
        false,
    ),
    (
        "nosRokurokubi",
        "nosRokurokubiVoiceEffectStrength",
        "settings.voice_effects.nos_rokurokubi_strength",
        1,
        false,
        false,
    ),
    (
        "nosBerserker",
        "nosBerserkerVoiceEffectStrength",
        "settings.voice_effects.nos_berserker_strength",
        0,
        true,
        true,
    ),
    (
        "nosCitrus",
        "nosCitrusVoiceEffectStrength",
        "settings.voice_effects.nos_citrus_strength",
        1,
        false,
        false,
    ),
    (
        "nosRainbowStar",
        "nosRainbowStarEchoStrength",
        "settings.voice_effects.nos_rainbow_star_strength",
        0,
        true,
        false,
    ),
    (
        "nosVoiceJamming",
        "nosVoiceJammingEffectStrength",
        "settings.lobbysettings.nos_voice_jamming_effect",
        -1,
        false,
        false,
    ),
    (
        "nosMegaphone",
        "nosMegaphoneEffectStrength",
        "settings.lobbysettings.nos_megaphone_effect",
        -1,
        false,
        false,
    ),
    (
        "nosBibiri",
        "nosBibiriEchoStrength",
        "settings.lobbysettings.nos_bibiri_echo",
        0,
        false,
        true,
    ),
];
pub fn tuning(s: &State, id: &str) -> Value {
    let definition = EFFECTS.iter().find(|d| d.0 == id).unwrap_or(&EFFECTS[0]);
    let strength = s.settings[definition.1]
        .as_f64()
        .unwrap_or(100.0)
        .clamp(0.0, 100.0);
    let stored = &s.settings["voiceEffectTunings"][id];
    json!({"pitch":stored["pitch"].as_f64().unwrap_or(strength*definition.3 as f64).clamp(-100.0,100.0),"reverb":stored["reverb"].as_f64().unwrap_or(if definition.4{strength}else{0.0}).clamp(0.0,100.0),"echo":stored["echo"].as_f64().unwrap_or(if definition.5{strength}else{0.0}).clamp(0.0,100.0)})
}
fn effect_available(s: &State, id: &str) -> bool {
    let mode = s.effective_game()["mod"].as_str().unwrap_or("");
    let uchu = s.effective_game()["nosAddonIds"]
        .as_array()
        .is_some_and(|a| a.contains(&json!("UchuAddon")));
    let tanuki = s.effective_game()["nosAddonIds"]
        .as_array()
        .is_some_and(|a| {
            a.iter().any(|v| {
                v.as_str()
                    .is_some_and(|s| s == "tanuki.bcl.roles" || s.to_lowercase().contains("tanuki"))
            })
        });
    id == "disguise"
        || mode == "SUPER_NEW_ROLES" && id.starts_with("snr")
        || mode == "NoS"
            && (matches!(id, "nosSize" | "nosRokurokubi" | "nosBerserker")
                || uchu && matches!(id, "nosCitrus" | "nosRainbowStar")
                || tanuki && matches!(id, "nosVoiceJamming" | "nosMegaphone" | "nosBibiri"))
}
pub fn selected_effect(s: &State) -> &str {
    if effect_available(s, &s.selected_effect) {
        &s.selected_effect
    } else {
        "disguise"
    }
}
fn effects(s: &State) -> String {
    let available = EFFECTS
        .iter()
        .filter(|d| effect_available(s, d.0))
        .collect::<Vec<_>>();
    let id = selected_effect(s);
    let choices = available
        .iter()
        .map(|d| {
            format!(
                "<option value={} {}>{}</option>",
                d.0,
                if d.0 == id { "selected" } else { "" },
                e(&s.t(d.2))
            )
        })
        .collect::<String>();
    let tuning = tuning(s, id);
    let mut html=format!("<div class=row-content><label>{}</label><select data-action=select-effect aria-label=\"{}\">{choices}</select><p class=hint>{}</p></div>",e(&s.t("settings.voice_effects.preview_target")),e(&s.t("settings.voice_effects.preview_target")),e(&s.t("settings.voice_effects.tuning_help")));
    for axis in ["pitch", "reverb", "echo"] {
        html.push_str(&format!("<div class=setting-row><div><label>{}</label>{}</div><div class=setting-control><div class=range><input type=range data-effect-axis={axis} min={} max=100 step=5 value={}><output>{}{}</output></div></div></div>",e(&s.t(&format!("settings.voice_effects.{axis}"))),if axis=="pitch"{format!("<p class=hint>{}</p>",e(&s.t("settings.voice_effects.pitch_help")))}else{String::new()},if axis=="pitch"{-100}else{0},tuning[axis],if axis=="pitch"&&tuning[axis].as_f64().unwrap_or(0.0)>0.0{"+"}else{""},if axis=="pitch"{text(&tuning[axis])}else{format!("{}%",text(&tuning[axis]))}));
    }
    if id == "nosRokurokubi" {
        html.push_str("<div class=row-content>首が伸びている間は顔と身体の両方から声が聞こえます。身体はこもったエコー音声です。</div>");
        for (key, label) in [
            ("rokuroVoice.headVolume", "顔の音量"),
            ("rokuroVoice.bodyVolume", "身体の音量"),
            ("rokuroVoice.bodyEcho", "身体のエコー"),
        ] {
            html.push_str(&row(s, key, label, "", (0.0, 100.0, 5.0), false));
        }
    }
    html.push_str(&format!(
        "<div class=effect-test-actions>{}{}</div>",
        button(
            "effect-test",
            &s.t("settings.audio.test_voice_effect_start")
        ),
        button("effect-stop", &s.t("settings.audio.test_voice_effect_stop"))
    ));
    section(&s.t("settings.voice_effects.title"), html)
}
pub fn obs_url(s: &State) -> String {
    let encode = crate::state::encode;
    format!("https://kuretoshi.github.io/BetterCrewlink-obs_fix/?version=3.2.62&compact={}&position={}&meeting={}&secret={}&server={}",if s.settings["compactOverlay"]==true{1}else{0},encode(s.settings["overlayPosition"].as_str().unwrap_or("right")),if s.settings["meetingOverlay"]==true{1}else{0},encode(s.settings["obsSecret"].as_str().unwrap_or("")),encode(s.settings["serverURL"].as_str().unwrap_or("")))
}
