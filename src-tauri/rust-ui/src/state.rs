use serde_json::{json, Value};
use std::sync::OnceLock;
pub fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../assets/release-data.json"))
            .expect("Validated release UI data")
    })
}
#[derive(Clone)]
pub struct State {
    pub view: String,
    pub viewport: [f64; 2],
    pub grid_size: Option<[f64; 2]>,
    pub category: String,
    pub version: String,
    pub settings: Value,
    pub game: Value,
    pub voice: Value,
    pub context: Value,
    pub catalog: Value,
    pub catalog_mode: String,
    pub catalog_loading: bool,
    pub catalog_retry: f64,
    pub meeting_ids: Vec<i64>,
    pub meeting_started: f64,
    pub devices: Value,
    pub error: String,
    pub message: String,
    pub form: Value,
    pub result: Value,
    pub updater: Value,
    pub selected_effect: String,
    pub busy: bool,
    pub rendered: String,
    pub settings_signature: String,
}
impl State {
    pub fn new() -> Self {
        let search = web_sys::window()
            .and_then(|w| w.location().search().ok())
            .unwrap_or_default();
        let parameter = |name: &str| {
            search
                .trim_start_matches('?')
                .split('&')
                .find_map(|p| {
                    p.split_once('=')
                        .filter(|(key, _)| *key == name)
                        .map(|(_, v)| v.to_owned())
                })
                .unwrap_or_default()
        };
        let view = parameter("view");
        Self::for_view(
            if view.is_empty() { "app" } else { &view },
            &parameter("version"),
        )
    }
    pub fn for_view(view: &str, version: &str) -> Self {
        Self {
            view: view.into(),
            viewport: [280.0, 390.0],
            grid_size: None,
            category: "general".into(),
            version: version.into(),
            settings: data()["defaults"].clone(),
            game: Value::Null,
            voice: json!({}),
            context: json!({}),
            catalog: json!({}),
            catalog_mode: String::new(),
            catalog_loading: false,
            catalog_retry: 0.0,
            meeting_ids: Vec::new(),
            meeting_started: 0.0,
            devices: json!({}),
            error: String::new(),
            message: String::new(),
            form: json!({}),
            result: json!({}),
            updater: json!({}),
            selected_effect: "disguise".into(),
            busy: false,
            rendered: String::new(),
            settings_signature: String::new(),
        }
    }
    pub fn t(&self, key: &str) -> String {
        let language = self.settings["language"].as_str().unwrap_or("ja");
        for language in [language, "ja", "en"] {
            let mut value = &data()["locales"][language];
            for part in key.split('.') {
                value = &value[part];
            }
            if let Some(text) = value.as_str() {
                return text.into();
            }
        }
        key.into()
    }
    pub fn notice(&self) -> String {
        if self.error.is_empty() {
            self.message.clone()
        } else {
            self.error.clone()
        }
    }
    pub fn effective_game(&self) -> &Value {
        let effective = &self.voice["status"]["effectiveGame"];
        if effective.is_object() {
            effective
        } else {
            &self.game
        }
    }
    pub fn needs_catalog(&self, mode: &str, now: f64) -> bool {
        !self.catalog_loading
            && (self.catalog_mode != mode
                || (!self.catalog["collection"].is_object() && now >= self.catalog_retry))
    }
    pub fn finish_catalog(&mut self, mode: &str, result: Result<Value, String>, now: f64) {
        self.catalog_loading = false;
        if self.catalog_mode != mode {
            return;
        }
        // An empty successful response needs the same backoff as a failure.
        // Rendering after it must never start an immediate request/render loop.
        self.catalog_retry = now + 60_000.0;
        if let Ok(catalog) = result {
            self.catalog = catalog;
        }
    }
    pub fn snapshot(&self) -> &Value {
        &self.voice["status"]["voiceSnapshot"]
    }
    pub fn merge_preferences(&mut self) {
        for descriptor in data()["settings"].as_array().into_iter().flatten() {
            if let Some(key) = descriptor["key"].as_str() {
                if at(&self.settings, key).is_null() {
                    let value = match descriptor["kind"].as_str() {
                        Some("SwitchRow") => json!(false),
                        Some("SliderRow") => json!(100),
                        _ => continue,
                    };
                    let _ = assign(&mut self.settings, key, value);
                }
            }
        }
        for (setting, pref, scale) in PREFERENCES {
            let value = &self.voice["preferences"][pref];
            if value.is_null() {
                continue;
            }
            self.settings[setting] = if scale != 1.0 {
                json!(value.as_f64().unwrap_or(0.0) * scale)
            } else if ["microphone", "speaker"].contains(&setting) && value == "" {
                json!("default")
            } else {
                value.clone()
            };
        }
    }
    pub fn host_in_match(&self) -> bool {
        let game = self.effective_game();
        game["isHost"] == true && matches!(game["gameState"].as_i64(), Some(1 | 2))
    }
}
pub fn toh_ghost_enabled(lobby: &Value, name: &str) -> bool {
    if lobby.get("tohGhostRoles").is_some() {
        lobby["tohGhostRoles"][name] == true
    } else {
        lobby["tohNeutralKillerHaunting"] == true
    }
}
pub fn toh_ghost_roles(
    lobby: &Value,
    catalog: &Value,
    selection: &str,
    group: bool,
    checked: bool,
) -> Result<Value, String> {
    let displayed: Vec<_> = catalog
        .as_array()
        .into_iter()
        .flatten()
        .filter(|role| {
            role["isKiller"] == true
                && matches!(role["customRoleType"].as_str(), Some("Neutral" | "Animals"))
        })
        .collect();
    let selected: Vec<_> = displayed
        .iter()
        .filter(|role| role[if group { "customRoleType" } else { "roleName" }] == selection)
        .collect();
    if selected.is_empty() {
        return Err("取得済みのTOH4E役職を選択してください".into());
    }
    let mut roles = if lobby["tohGhostRoles"].is_object() {
        lobby["tohGhostRoles"].clone()
    } else {
        json!({})
    };
    for role in &displayed {
        if let Some(name) = role["roleName"].as_str() {
            roles[name] = json!(toh_ghost_enabled(lobby, name));
        }
    }
    for role in selected {
        if let Some(name) = role["roleName"].as_str() {
            roles[name] = json!(checked);
        }
    }
    Ok(roles)
}
pub fn encode(value: &str) -> String {
    const COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(value, COMPONENT).to_string()
}
pub fn server_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    let url = url::Url::parse(value).map_err(|_| "通話サーバーのURLを確認してください")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.host_str() == Some("discord.gg")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("通話サーバーは http(s)://ホスト[:ポート] を指定してください".into());
    }
    Ok(value.trim_end_matches('/').to_owned())
}
pub fn valid_shortcut(name: &str) -> bool {
    name.len() == 1 && name.as_bytes()[0].is_ascii_alphanumeric()
        || name
            .strip_prefix('F')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=24).contains(&n))
        || name
            .strip_prefix("Numpad")
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| n <= 9)
        || [
            "Disabled",
            "Space",
            "Backspace",
            "Delete",
            "Enter",
            "Up",
            "Down",
            "Left",
            "Right",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "CapsLock",
            "LShift",
            "RShift",
            "LAlt",
            "RAlt",
            "LControl",
            "RControl",
            "NumpadAdd",
            "NumpadSubtract",
            "NumpadMultiply",
            "NumpadDivide",
            "NumpadDecimal",
            "NumpadEnter",
        ]
        .contains(&name)
}
pub const PREFERENCES: [(&str, &str, f64); 13] = [
    ("serverURL", "serverUrl", 1.0),
    ("microphone", "microphone", 1.0),
    ("speaker", "speaker", 1.0),
    ("masterVolume", "volume", 100.0),
    ("microphoneGain", "microphoneGain", 100.0),
    ("microphoneGainEnabled", "microphoneGainEnabled", 1.0),
    ("micSensitivity", "micSensitivity", 1.0),
    ("micSensitivityEnabled", "micSensitivityEnabled", 1.0),
    ("enableSpatialAudio", "spatialAudio", 1.0),
    ("pushToTalkMode", "pushToTalkMode", 1.0),
    ("echoCancellation", "echoCancellation", 1.0),
    ("noiseSuppression", "noiseSuppression", 1.0),
    ("autoGainControl", "autoGainControl", 1.0),
];
pub fn at<'a>(value: &'a Value, path: &str) -> &'a Value {
    let mut result = value;
    for key in path.split('.') {
        result = &result[key];
    }
    result
}
pub fn assign(value: &mut Value, path: &str, next: Value) -> Result<(), String> {
    let keys: Vec<_> = path.split('.').collect();
    if keys.len() > 5
        || keys
            .iter()
            .any(|k| k.is_empty() || ["__proto__", "constructor", "prototype"].contains(k))
    {
        return Err("Invalid setting path".into());
    }
    let mut cursor = value;
    for key in &keys[..keys.len() - 1] {
        if !cursor.is_object() {
            *cursor = json!({});
        }
        cursor = cursor
            .as_object_mut()
            .unwrap()
            .entry((*key).to_owned())
            .or_insert(json!({}));
    }
    if !cursor.is_object() {
        *cursor = json!({});
    }
    cursor[keys[keys.len() - 1]] = next;
    Ok(())
}
pub fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
pub fn text(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_else(|| {
        if value.is_null() {
            String::new()
        } else {
            value.to_string()
        }
    })
}
pub fn custom_platform(
    name: &str,
    path: &str,
    kind: &str,
    arguments: &str,
) -> Result<Value, String> {
    if name.trim().is_empty() || name.encode_utf16().count() > 80 || path.trim().is_empty() {
        return Err("表示名と起動先を確認してください".into());
    }
    let (directory, execute) = if kind == "EXE" {
        let (directory, file) = path
            .rsplit_once(['\\', '/'])
            .ok_or("実行ファイルの完全なパスを指定してください")?;
        if !file.to_ascii_lowercase().ends_with(".exe") {
            return Err("実行ファイルを選択してください".into());
        }
        let mut execute = vec![file.to_owned()];
        if !arguments.is_empty() {
            execute.extend(arguments.split(' ').map(str::to_owned));
        }
        (
            if directory.ends_with(':') {
                format!("{directory}\\")
            } else {
                directory.to_owned()
            },
            execute,
        )
    } else if kind == "URI" {
        (path.to_owned(), Vec::new())
    } else {
        return Err("起動形式を選択してください".into());
    };
    Ok(
        json!({"name":name,"key":name,"default":false,"launchType":kind,"runPath":directory,"execute":execute,"translateKey":name}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ui_values_cannot_inject_markup_or_prototype_paths() {
        assert_eq!(
            escaped("<img src=x onerror='bad'>&"),
            "&lt;img src=x onerror=&#39;bad&#39;&gt;&amp;"
        );
        let mut v = json!({});
        assert!(assign(&mut v, "__proto__.x", json!(1)).is_err());
        assign(&mut v, "voiceEffectTunings.disguise.pitch", json!(-50)).unwrap();
        assert_eq!(at(&v, "voiceEffectTunings.disguise.pitch"), -50);
    }
}
