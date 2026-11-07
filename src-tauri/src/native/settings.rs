use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub struct Settings {
    defaults: Value,
    saved: Value,
    temporary: BTreeMap<String, Value>,
    path: PathBuf,
}

pub fn merge(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            match target.get_mut(key) {
                Some(previous) if previous.is_object() && value.is_object() => {
                    merge(previous, value)
                }
                _ => {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
    }
}

pub fn assign(target: &mut Value, key: &str, value: Value) -> Result<(), String> {
    let segments: Vec<_> = key.split('.').collect();
    if segments.len() > 5
        || segments
            .iter()
            .any(|s| s.is_empty() || ["__proto__", "constructor", "prototype"].contains(s))
    {
        return Err("Invalid setting path".into());
    }
    let mut cursor = target;
    for segment in &segments[..segments.len() - 1] {
        if !cursor.is_object() {
            *cursor = serde_json::json!({});
        }
        cursor = cursor
            .as_object_mut()
            .unwrap()
            .entry(segment.to_string())
            .or_insert(serde_json::json!({}));
    }
    cursor
        .as_object_mut()
        .ok_or("Invalid setting parent")?
        .insert(segments.last().unwrap().to_string(), value);
    Ok(())
}

impl Settings {
    pub fn load(data: &Path, resources: &Path) -> Result<Self, String> {
        let defaults = serde_json::from_slice(
            &fs::read(resources.join("rust-default-settings.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let path = data.join("config.json");
        let saved = if path.exists() {
            serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("設定ファイルを読み取れません: {e}"))?
        } else {
            serde_json::json!({})
        };
        if !saved.is_object() {
            return Err("Invalid settings file".into());
        }
        Ok(Self {
            defaults,
            saved,
            temporary: BTreeMap::new(),
            path,
        })
    }
    pub fn current(&self) -> Value {
        let mut current = self.defaults.clone();
        merge(&mut current, &self.saved);
        for (key, value) in &self.temporary {
            let _ = assign(&mut current, key, value.clone());
        }
        current
    }
    pub fn set(&mut self, key: &str, value: Value, persist: bool) -> Result<(), String> {
        if key.len() > 256 || key.starts_with("__") {
            return Err("Invalid setting".into());
        }
        let root = key.split('.').next().unwrap_or("");
        if self.defaults.get(root).is_none()
            && !["obsSecret", "customPlatforms", "playerConfigMap"].contains(&root)
        {
            return Err("Unknown setting".into());
        }
        if persist {
            let mut saved = self.saved.clone();
            assign(&mut saved, key, value)?;
            self.persist(&saved)?;
            self.saved = saved;
            self.temporary.remove(key);
        } else {
            self.temporary.insert(key.into(), value);
        }
        Ok(())
    }
    pub fn clear(&mut self) -> Result<(), String> {
        let saved = serde_json::json!({});
        self.persist(&saved)?;
        self.saved = saved;
        self.temporary.clear();
        Ok(())
    }
    fn persist(&self, value: &Value) -> Result<(), String> {
        let temporary = self.path.with_extension("rust.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, &self.path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_overrides_preserve_siblings_and_reject_prototype_paths() {
        let mut value = serde_json::json!({"playerConfigMap":{"7":{"volume":30}},"myLobbySettings":{"maxDistance":5.3,"haunting":true}});
        merge(
            &mut value,
            &serde_json::json!({"myLobbySettings":{"maxDistance":7}}),
        );
        assign(
            &mut value,
            "playerConfigMap.8.volume",
            serde_json::json!(40),
        )
        .unwrap();
        assert_eq!(value["myLobbySettings"]["haunting"], true);
        assert_eq!(value["playerConfigMap"]["7"]["volume"], 30);
        assert_eq!(value["playerConfigMap"]["8"]["volume"], 40);
        assert!(assign(&mut value, "__proto__.x", Value::Null).is_err());
    }
    #[test]
    fn persistent_and_temporary_preferences_survive_only_the_expected_lifetimes() {
        let temp = std::env::temp_dir();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = temp.join(format!("tanukibcl-rust-settings-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("rust-default-settings.json"),
            br#"{"masterVolume":100,"playerConfigMap":{}}"#,
        )
        .unwrap();
        let mut settings = Settings::load(&root, &root).unwrap();
        settings
            .set("masterVolume", serde_json::json!(30), true)
            .unwrap();
        settings
            .set("masterVolume", serde_json::json!(50), false)
            .unwrap();
        assert_eq!(settings.current()["masterVolume"], 50);
        let mut reloaded = Settings::load(&root, &root).unwrap();
        assert_eq!(reloaded.current()["masterVolume"], 30);
        assert!(reloaded.set("__proto__.x", Value::Null, true).is_err());
        reloaded.clear().unwrap();
        assert_eq!(
            Settings::load(&root, &root).unwrap().current()["masterVolume"],
            100
        );
        fs::write(root.join("config.json"), b"broken").unwrap();
        assert!(Settings::load(&root, &root).is_err());
        assert_eq!(fs::read(root.join("config.json")).unwrap(), b"broken");
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(temp.canonicalize().unwrap()));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tanukibcl-rust-settings-"));
        fs::remove_dir_all(root).unwrap();
    }
}
