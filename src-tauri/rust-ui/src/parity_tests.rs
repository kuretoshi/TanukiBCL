use crate::{
    settings,
    state::{data, State},
    views,
};
use serde_json::{json, Value};
#[test]
fn audible_clone_restores_speaking_ring_for_disguised_venting_owner() {
    let mut state = State::for_view("app", "test");
    state.game = json!({"mod":"NoS","gameState":1});
    state.voice =
        json!({"status":{"voiceSnapshot":{"otherTalking":{},"cloneTalking":{"99":true}}}});
    let p = json!({"id":1,"clientId":99,"name":"clone","colorId":0,"shiftedColor":3,"currentOutfit":1,"appearanceColorId":3,"inVent":true});
    let html = views::avatar(&state, &p);
    assert!(html.contains("player talking"));
    assert!(!html.contains("appearance-hidden"));
    state.voice["status"]["voiceSnapshot"]["cloneTalking"] = json!({});
    let html = views::avatar(&state, &p);
    assert!(!html.contains("player talking"));
    assert!(html.contains("appearance-hidden"));
}
#[test]
fn every_release_setting_descriptor_has_a_control_in_the_rust_ui() {
    let mut state = State::for_view("settings", "test");
    state.merge_preferences();
    let mut html = String::new();
    for mode in ["NONE", "NoS", "SUPER_NEW_ROLES", "TOH4E"] {
        state.game = json!({"mod":mode,"nosAddonIds":["UchuAddon"]});
        state.form = json!({"platformDialog":true,"serverDialog":false,"tohRolesOpen":true});
        state.settings["obsOverlay"] = json!(true);
        for (category, _) in settings::CATEGORIES {
            state.category = category.into();
            html.push_str(&settings::render(&state));
        }
        state.form["platformDialog"] = json!(false);
        state.form["serverDialog"] = json!(true);
        html.push_str(&settings::render(&state));
    }
    state.form["serverDialog"] = json!(false);
    state.form["debugDialog"] = json!(true);
    html.push_str(&settings::render(&state));
    for row in data()["settings"].as_array().unwrap() {
        let key = row["key"].as_str().unwrap();
        assert!(
            html.contains(&format!("data-setting=\"{key}\""))
                || html.contains(&format!("data-setting={key} "))
                || html.contains(&format!("data-setting-list={key}")),
            "Missing release control: {key}"
        );
    }
    for action in [
        "save-platform",
        "open-debug",
        "reset-settings",
        "effect-test",
        "speaker-test",
        "copy-obs",
        "submit-inquiry",
        "check-updates",
    ] {
        assert!(html.contains(action), "Missing feature: {action}");
    }
}
#[test]
fn rerender_keeps_inquiry_and_platform_drafts_without_creating_markup() {
    let mut state = State::for_view("settings", "test");
    state.merge_preferences();
    state.category = "advanced".into();
    state.form = json!({"platformDialog":true,"platformName":"Test <launcher>","platformPath":"C:\\Games\\Among Us.exe","platformArgs":"--test","platformType":"URI","tag":"bug","subject":"<test>","body":"draft & details"});
    let html = settings::render(&state);
    assert!(html.contains("Test &lt;launcher&gt;"));
    assert!(html.contains("C:\\Games\\Among Us.exe"));
    assert!(html.contains("value=URI checked"));
    state.busy = true;
    let html = views::inquiry(&state);
    assert!(html.contains("value=bug selected"));
    assert!(html.contains("&lt;test&gt;"));
    assert!(html.contains("draft &amp; details"));
    assert!(html.contains("type=button disabled data-action=\"submit-inquiry\""));
}
#[test]
fn nos_and_snr_outfits_use_native_layers_and_do_not_reveal_hidden_radio_users() {
    let mut state = State::for_view("app", "test");
    state.game = json!({"mod":"NoS","gameState":1,"players":[]});
    state.voice =
        json!({"status":{"voiceSnapshot":{"impostorRadioClientIds":[]},"radioClients":[99]}});
    let player = json!({"id":1,"clientId":99,"colorId":0,"name":"original","appearanceName":"display","currentOutfit":1,"appearanceColorId":3,"nosLobbyColor":"#12abef","nosCosmetics":{"hat":"nos-cosmetic://image/hat","bodyMask":"nos-cosmetic://image/mask"}});
    let html = views::avatar(&state, &player);
    assert!(html.contains("data:image/png;base64,"));
    assert!(html.contains("https://nos-cosmetic.localhost/image/hat"));
    assert!(html.contains("mask-loader"));
    assert!(html.contains(">display</strong>"));
    assert!(!html.contains("📻"));
    state.game["mod"] = json!("SUPER_NEW_ROLES");
    let mut player = player;
    player["appearanceHatId"] = json!("Modded_Test_試作");
    player["snrHat2Id"] = json!("Modded_Test_Second");
    let html = views::avatar(&state, &player);
    assert!(html.contains("snr-cosmetic.localhost/hat-front/Modded_Test_%E8%A9%A6%E4%BD%9C"));
    assert!(html.contains("hat2-front"));
}
#[test]
fn custom_launcher_preserves_a_drive_root_and_separates_executable_arguments() {
    let platform =
        crate::state::custom_platform("Test", "C:\\Among Us.exe", "EXE", "--one two").unwrap();
    assert_eq!(platform["runPath"], "C:\\");
    assert_eq!(platform["execute"], json!(["Among Us.exe", "--one", "two"]));
    assert!(crate::state::custom_platform("Test", "C:\\wrong.txt", "EXE", "").is_err());
}
#[test]
fn invalid_servers_are_rejected_before_any_preferences_are_saved() {
    assert_eq!(
        crate::state::server_url(" https://example.test/ ").unwrap(),
        "https://example.test"
    );
    for url in [
        "file:///tmp",
        "https://discord.gg/test",
        "https://user:pass@example.test",
        "https://example.test/path",
        "https://example.test?token=secret",
    ] {
        assert!(crate::state::server_url(url).is_err(), "{url}");
    }
}
#[test]
fn transformed_appearances_are_hidden_during_tasks_and_empty_cosmetics_are_equivalent() {
    let mut player = json!({"currentOutfit":1,"colorId":0,"appearanceColorId":0,"hatId":"hat_NoHat","appearanceHatId":"","skinId":"skin_None","visorId":"visor_EmptyVisor"});
    assert!(!crate::avatar::appearance_changed(&player));
    player["appearanceColorId"] = json!(2);
    assert!(crate::avatar::appearance_changed(&player));
    let mut state = State::for_view("app", "test");
    state.game = json!({"gameState":1});
    assert!(views::avatar(&state, &player).contains("appearance-hidden"));
    state.game["gameState"] = json!(2);
    assert!(!views::avatar(&state, &player).contains("appearance-hidden"));
}
#[test]
fn integer_ban_flags_from_the_release_api_are_respected() {
    let mut state = State::for_view("player-history", "test");
    state.result["bans"] = json!({"history":[{"uid_digest":"fixture","is_banned":1}],"historyTotal":1,"ipBansAvailable":false});
    let html = views::bans(&state, true);
    assert!(html.contains("UID: BAN済み"));
    assert!(!html.contains("data-action=ban-record"));
}
#[test]
fn toh_role_edits_preserve_legacy_ghost_defaults_and_only_change_eligible_roles() {
    let catalog = json!([{"roleName":"Jackal","displayName":"Jackal","customRoleType":"Neutral","isKiller":true},{"roleName":"Dog","displayName":"Dog","customRoleType":"Animals","isKiller":true},{"roleName":"Crewmate","displayName":"Crewmate","customRoleType":"Crewmate","isKiller":false}]);
    let mut lobby = json!({"tohNeutralKillerHaunting":true});
    let roles = crate::state::toh_ghost_roles(&lobby, &catalog, "Jackal", false, false).unwrap();
    assert_eq!(roles, json!({"Jackal":false,"Dog":true}));
    lobby["tohGhostRoles"] = json!({"Jackal":false,"retainedUnknownRole":true});
    let roles = crate::state::toh_ghost_roles(&lobby, &catalog, "Animals", true, true).unwrap();
    assert_eq!(
        roles,
        json!({"Jackal":false,"Dog":true,"retainedUnknownRole":true})
    );
    assert!(crate::state::toh_ghost_roles(&lobby, &catalog, "Crewmate", false, true).is_err());
    let mut state = State::for_view("settings", "test");
    state.merge_preferences();
    state.category = "lobby".into();
    state.game = json!({"mod":"TOH4E"});
    state.form["tohRolesOpen"] = json!(true);
    state.voice = json!({"status":{"voiceSnapshot":{"tohRoleCatalog":catalog}}});
    let html = settings::render(&state);
    assert!(html.contains("data-action=toh-group"));
    assert!(html.contains("myLobbySettings.tohGhostRoles.Jackal"));
    assert!(!html.contains("myLobbySettings.tohGhostRoles.Crewmate"));
}
#[test]
fn key_capture_only_accepts_keys_supported_by_the_native_hook() {
    for key in [
        "Disabled",
        "Space",
        "RControl",
        "Numpad0",
        "NumpadEnter",
        "F24",
        "V",
    ] {
        assert!(crate::state::valid_shortcut(key));
    }
    for key in [
        "Tab",
        "F99",
        "Backquote",
        "NumpadUnmapped",
        "Process",
        "MetaLeft",
    ] {
        assert!(!crate::state::valid_shortcut(key));
    }
}
#[test]
fn empty_cosmetics_responses_do_not_start_an_unbounded_render_request_loop() {
    for response in [Ok(json!({})), Ok(Value::Null), Err("offline".into())] {
        let mut state = State::for_view("app", "test");
        assert!(state.needs_catalog("NoS", 1000.0));
        state.catalog_mode = "NoS".into();
        state.catalog_loading = true;
        assert!(!state.needs_catalog("NoS", 1000.0));
        state.finish_catalog("NoS", response, 1000.0);
        for poll in 0..300 {
            assert!(!state.needs_catalog("NoS", 1000.0 + poll as f64 * 200.0));
        }
        assert!(state.needs_catalog("NoS", 61000.0));
        assert!(state.needs_catalog("SUPER_NEW_ROLES", 1200.0));
        state.finish_catalog("NoS", Ok(json!({"collection":{}})), 61000.0);
        assert!(!state.needs_catalog("NoS", 1_000_000.0));
    }
}
#[test]
fn player_grid_matches_the_electron_algorithm_for_window_sizes_and_groups() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../assets/player-grid-goldens.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let (actual_columns, actual_size) = crate::chrome::player_grid(
            case["width"].as_f64().unwrap(),
            case["height"].as_f64().unwrap(),
            case["count"].as_u64().unwrap() as usize,
            case["split"].as_u64().map(|v| v as usize),
        );
        assert_eq!(
            (actual_columns, actual_size),
            (
                case["columns"].as_u64().unwrap() as usize,
                case["avatarSize"].as_u64().unwrap() as u32
            ),
            "{case}"
        );
    }
}
