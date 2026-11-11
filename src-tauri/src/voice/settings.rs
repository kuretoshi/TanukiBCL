use super::model::*;
use serde_json::Value;

pub fn preferences(shared: &Value) -> Preferences {
    Preferences {
        microphone: shared["microphone"]
            .as_str()
            .filter(|s| *s != "default")
            .unwrap_or("")
            .into(),
        speaker: shared["speaker"]
            .as_str()
            .filter(|s| *s != "default")
            .unwrap_or("")
            .into(),
        server_url: shared["serverURL"]
            .as_str()
            .unwrap_or("https://bettercrewl.ink")
            .into(),
        volume: (number(shared, "masterVolume", 100.0) / 100.0).clamp(0.0, 2.0) as f32,
        microphone_gain: (number(shared, "microphoneGain", 100.0) / 100.0).clamp(0.0, 4.0) as f32,
        microphone_gain_enabled: flag(shared, "microphoneGainEnabled"),
        mic_sensitivity: number(shared, "micSensitivity", 0.15).clamp(0.0, 1.0) as f32,
        mic_sensitivity_enabled: flag(shared, "micSensitivityEnabled"),
        spatial_audio: shared["enableSpatialAudio"].as_bool().unwrap_or(true),
        push_to_talk_mode: shared["pushToTalkMode"].as_u64().unwrap_or(0).min(2) as u8,
        echo_cancellation: shared["echoCancellation"].as_bool().unwrap_or(true),
        noise_suppression: shared["noiseSuppression"].as_bool().unwrap_or(true),
        auto_gain_control: shared["autoGainControl"].as_bool().unwrap_or(true),
        ..Default::default()
    }
}
pub fn load(base: &Preferences, bytes: &[u8]) -> Result<Preferences, String> {
    let mut merged = serde_json::to_value(base).map_err(|e| e.to_string())?;
    let stored: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let stored = stored
        .as_object()
        .ok_or("Voice preferences must be an object")?;
    for (key, value) in stored {
        merged[key] = value.clone();
    }
    serde_json::from_value(merged).map_err(|e| e.to_string())
}
pub fn changed(prefs: &Preferences, before: &Value, after: &Value) -> Result<Preferences, String> {
    let mut result = serde_json::to_value(prefs).map_err(|e| e.to_string())?;
    let derived = serde_json::to_value(preferences(after)).map_err(|e| e.to_string())?;
    for (source, target) in [
        ("microphone", "microphone"),
        ("speaker", "speaker"),
        ("serverURL", "serverUrl"),
        ("masterVolume", "volume"),
        ("microphoneGain", "microphoneGain"),
        ("microphoneGainEnabled", "microphoneGainEnabled"),
        ("micSensitivity", "micSensitivity"),
        ("micSensitivityEnabled", "micSensitivityEnabled"),
        ("enableSpatialAudio", "spatialAudio"),
        ("pushToTalkMode", "pushToTalkMode"),
        ("echoCancellation", "echoCancellation"),
        ("noiseSuppression", "noiseSuppression"),
        ("autoGainControl", "autoGainControl"),
    ] {
        if before[source] != after[source] {
            result[target] = derived[target].clone();
        }
    }
    let result: Preferences = serde_json::from_value(result).map_err(|e| e.to_string())?;
    result.validate()?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ordinary_lobby_edits_do_not_replace_native_device_or_server_choices() {
        let mut prefs = Preferences::default();
        prefs.server_url = "http://localhost:3000".into();
        prefs.microphone = "native-device".into();
        let before = json!({"serverURL":"https://bettercrewl.ink","masterVolume":100,"myLobbySettings":{"wallsBlockAudio":false}});
        let mut after = before.clone();
        after["myLobbySettings"]["wallsBlockAudio"] = json!(true);
        assert_eq!(changed(&prefs, &before, &after).unwrap(), prefs);
        after["masterVolume"] = json!(50);
        let updated = changed(&prefs, &before, &after).unwrap();
        assert_eq!(updated.volume, 0.5);
        assert_eq!(updated.server_url, prefs.server_url);
        assert_eq!(updated.microphone, prefs.microphone);
    }
    #[test]
    fn missing_native_fields_inherit_shared_values_and_unknown_fields_are_rejected() {
        let defaults = preferences(&json!({"microphoneGain":180,"microphoneGainEnabled":true}));
        let loaded = load(&defaults, br#"{"volume":0.5}"#).unwrap();
        assert_eq!(loaded.volume, 0.5);
        assert_eq!(loaded.microphone_gain, 1.8);
        assert!(loaded.microphone_gain_enabled);
        assert!(load(&defaults, br#"{"unknown":true}"#).is_err());
    }
}
