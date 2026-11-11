//! 16 kHz listener-local captures. Raw inputs only; playback never feeds capture.
use super::*;
use serde_json::{json, Map};
const HZ: u64 = 16000;
const HISTORY: usize = 4800;
struct Recording {
    pcm: Clip,
    source: u64,
    start: u64,
}
struct Slot {
    entry: Value,
    clips: HashMap<u64, Recording>,
    handled: u64,
    requested: u64,
    cursor: Option<usize>,
    gain: [f32; 2],
    energy: VecDeque<f32>,
    sum: f32,
}
#[derive(Default)]
struct Input {
    player: Value,
    allowed: bool,
    volume: f32,
    history: VecDeque<(u64, f32)>,
    energy: f32,
}
#[derive(Default)]
pub(super) struct Bank {
    slots: HashMap<(u64, u64), Slot>,
    inputs: HashMap<u64, Input>,
    captures: HashMap<u64, Vec<((u64, u64), u64)>>,
    requests: Vec<(u64, u64, u64)>,
    state: Value,
    tasks: bool,
    host: bool,
    enabled: bool,
}
fn near(entry: &Value, player: &Value, state: &Value) -> bool {
    if !["x", "y"]
        .iter()
        .all(|key| player[*key].as_f64().is_some_and(f64::is_finite))
    {
        return false;
    }
    !flag(player, "disconnected")
        && !flag(player, "inVent")
        && (number(entry, "x", 1e9) - number(player, "x", 0.))
            .hypot(number(entry, "y", 1e9) - number(player, "y", 0.))
            <= number(entry, "range", 0.)
        && !super::super::geometry::blocks(
            state["map"].as_i64().unwrap_or(6),
            [number(player, "x", 1e9), number(player, "y", 1e9)],
            [number(entry, "x", 0.), number(entry, "y", 0.)],
            &state["closedDoors"],
        )
}
fn seconds(entry: &Value) -> f64 {
    number(entry, "seconds", 1.5)
}
impl Bank {
    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }
    pub(super) fn update(
        &mut self,
        state: &Value,
        prefs: &Preferences,
        shared: &Value,
        clients: &Map<String, Value>,
        rules: &Value,
        radios: &[i64],
        permitted: bool,
        audible: bool,
        t: u64,
        budget: &Arc<AtomicUsize>,
    ) {
        if !permitted
            || !super::super::roles::addon(state)
            || !matches!(state["gameState"].as_i64(), Some(1 | 2))
            || state["nosParrots"].as_array().is_none_or(|rs| {
                rs.is_empty()
                    || rs.len() > 120
                    || !rs
                        .iter()
                        .any(|r| crate::native::mods::addon::row_valid("parrots", r, t))
            })
        {
            self.clear();
            return;
        }
        let Some(me) = local(state) else {
            self.clear();
            return;
        };
        self.state = state.clone();
        self.tasks = state["gameState"] == 1;
        self.host = state["isHost"] == true;
        self.enabled = audible
            && prefs.volume > 0.
            && !(flag(rules, "commsSabotage")
                && flag(state, "comsSabotaged")
                && !super::super::roles::impostor(state, me));
        let mut keep = HashSet::new();
        for p in state["players"].as_array().into_iter().flatten().take(24) {
            let Some(id) = p["id"].as_u64().filter(|v| *v <= 255) else {
                continue;
            };
            if flag(p, "disconnected")
                || !(flag(p, "isLocal") || clients.values().any(|c| c["clientId"] == p["clientId"]))
            {
                continue;
            }
            keep.insert(id);
            let config = player_config(shared, p);
            let input = self.inputs.entry(id).or_default();
            input.player = p.clone();
            input.allowed = !flag(p, "isDead")
                && !flag(config, "isMuted")
                && !radios.contains(&p["clientId"].as_i64().unwrap_or(-1))
                && !state["nosInterviews"].as_array().is_some_and(|rs| {
                    rs.iter().any(|r| {
                        r["visible"]
                            .as_array()
                            .is_some_and(|vs| vs.contains(&p["id"]))
                            && r["stopped"] == 0
                    })
                });
            input.volume = if flag(config, "isMuted") {
                0.
            } else {
                number(config, "volume", 1.).clamp(0., 2.) as f32
            };
            if !self.tasks || !self.enabled || !input.allowed {
                input.history.clear();
                input.energy = 0.;
            }
        }
        self.inputs.retain(|id, _| keep.contains(id));
        let entries: Vec<_> = state["nosParrots"]
            .as_array()
            .filter(|rs| rs.len() <= 120)
            .into_iter()
            .flatten()
            .filter(|p| crate::native::mods::addon::row_valid("parrots", p, t))
            .collect();
        let keys: HashSet<_> = entries
            .iter()
            .map(|p| {
                (
                    p["ownerId"].as_u64().unwrap(),
                    p["birdId"].as_u64().unwrap(),
                )
            })
            .collect();
        self.slots.retain(|key, _| keys.contains(key));
        for entry in entries {
            let key = (
                entry["ownerId"].as_u64().unwrap(),
                entry["birdId"].as_u64().unwrap(),
            );
            let slot = self.slots.entry(key).or_insert_with(|| Slot {
                entry: entry.clone(),
                clips: HashMap::new(),
                handled: 0,
                requested: 0,
                cursor: None,
                gain: [0.; 2],
                energy: VecDeque::new(),
                sum: 0.,
            });
            slot.entry = entry.clone();
            let record = entry["recordId"].as_u64().unwrap();
            slot.clips.retain(|id, _| {
                entry["clips"]
                    .as_array()
                    .is_some_and(|cs| cs.contains(&json!(id)))
                    || self.tasks && *id == record
            });
            if self.tasks
                && record > 0
                && !slot.clips.contains_key(&record)
                && (t as f64) < number(entry, "started", 0.) + seconds(entry) * 1000.
            {
                if let Some(pcm) =
                    Clip::new((seconds(entry) * HZ as f64).ceil() as usize, budget, true)
                {
                    let source = entry["sourceId"].as_u64().unwrap();
                    let start = (entry["started"].as_u64().unwrap() * 16)
                        .saturating_sub(if entry["mode"] == "clone" { 0 } else { 2400 });
                    let mut clip = Recording { pcm, source, start };
                    if let Some(input) = self.inputs.get(&source).filter(|i| i.allowed) {
                        for (stamp, sample) in &input.history {
                            write(&mut clip, *stamp, *sample);
                        }
                    }
                    slot.clips.insert(record, clip);
                }
            }
            let play = entry["playId"].as_u64().unwrap();
            let looping = entry["mode"] == "clone";
            if !self.tasks || !self.enabled {
                slot.cursor = None;
                slot.energy.clear();
                slot.sum = 0.;
            }
            if slot.handled != play
                || looping && slot.cursor.is_none() && self.tasks && self.enabled
            {
                slot.handled = play;
                slot.cursor = None;
                slot.energy.clear();
                slot.sum = 0.;
                let offset = t.saturating_sub(entry["playStarted"].as_u64().unwrap()) * 16;
                if play > 0 && self.tasks && self.enabled && (looping || near(entry, me, state)) {
                    if let Some(clip) = entry["playClip"]
                        .as_u64()
                        .and_then(|id| slot.clips.get(&id))
                    {
                        let n = clip.pcm.data.len();
                        let offset = if looping && n > 0 {
                            offset as usize % n
                        } else {
                            offset as usize
                        };
                        if offset < n {
                            slot.cursor = Some(offset * 3);
                        }
                    }
                }
            }
            let source = entry["playClip"]
                .as_u64()
                .and_then(|id| slot.clips.get(&id))
                .and_then(|c| self.inputs.get(&c.source));
            let gain = if self.tasks && self.enabled && near(entry, me, state) {
                let distance = (number(entry, "x", 0.) - number(me, "x", 0.))
                    .hypot(number(entry, "y", 0.) - number(me, "y", 0.));
                prefs.volume
                    * source.map_or(0., |s| s.volume)
                    * (1. - distance / number(entry, "range", 1.)).max(0.) as f32
            } else {
                0.
            };
            let pan = ((number(entry, "x", 0.) - number(me, "x", 0.)) / number(entry, "range", 1.))
                .clamp(-1., 1.);
            let theta = (pan + 1.) * std::f64::consts::FRAC_PI_4;
            slot.gain = [gain * theta.cos() as f32, gain * theta.sin() as f32];
        }
        // Select capture targets on state changes, rather than scanning every
        // bird and doing wall geometry for every 16 kHz sample of every peer.
        self.captures.clear();
        if self.tasks && self.enabled {
            for (key, slot) in &self.slots {
                let Some((record, clip)) = slot.entry["recordId"]
                    .as_u64()
                    .and_then(|id| slot.clips.get(&id).map(|c| (id, c)))
                else {
                    continue;
                };
                if t * 16 >= clip.start + clip.pcm.data.len() as u64 {
                    continue;
                }
                if self.inputs.get(&clip.source).is_some_and(|i| {
                    i.allowed
                        && (slot.entry["mode"] == "clone"
                            || near(&slot.entry, &i.player, &self.state))
                }) {
                    self.captures
                        .entry(clip.source)
                        .or_default()
                        .push((*key, record));
                }
            }
        }
    }
    pub(super) fn input(&mut self, player: u64, raw: f32, stamp: u64, allowed: bool) {
        if !self.tasks || !self.enabled {
            return;
        }
        let Some(input) = self.inputs.get_mut(&player) else {
            return;
        };
        if !allowed || !input.allowed {
            input.history.clear();
            input.energy = 0.;
            return;
        }
        if stamp % 3 != 0 {
            return;
        }
        let stamp = stamp / 3;
        input.energy += (raw * raw - input.energy) * 0.005;
        input.history.push_back((stamp, raw));
        if input.history.len() > HISTORY {
            input.history.pop_front();
        }
        if self.host && stamp % 320 == 0 && input.energy >= 0.008f32.powi(2) {
            for ((owner, bird), slot) in &mut self.slots {
                let clone = slot.entry["mode"] == "clone";
                let end = slot.entry["started"].as_u64().unwrap_or(0) * 16
                    + (seconds(&slot.entry) * 16000.) as u64;
                if !clone
                    && self.host
                    && input.energy >= 0.008f32.powi(2)
                    && stamp >= slot.requested
                    && !(slot.entry["recordId"] != 0 && stamp < end + 2400)
                    && near(&slot.entry, &input.player, &self.state)
                {
                    slot.requested = stamp + (seconds(&slot.entry) * 16000.) as u64 + 3200;
                    if self.requests.len() < 120 {
                        self.requests.push((*owner, *bird, player));
                    }
                }
            }
        }
        for (key, record) in self.captures.get(&player).into_iter().flatten() {
            if let Some(clip) = self
                .slots
                .get_mut(key)
                .and_then(|s| s.clips.get_mut(record))
            {
                write(clip, stamp, raw);
            }
        }
    }
    pub(super) fn next(&mut self, muted: bool) -> [f32; 2] {
        let mut mixed = [0.; 2];
        for slot in self.slots.values_mut() {
            if muted || !self.enabled {
                slot.cursor = None;
                slot.energy.clear();
                slot.sum = 0.;
                continue;
            }
            let Some(cursor) = slot.cursor else {
                continue;
            };
            let Some(clip) = slot.entry["playClip"]
                .as_u64()
                .and_then(|id| slot.clips.get(&id))
            else {
                slot.cursor = None;
                continue;
            };
            let n = clip.pcm.data.len() * 3;
            if cursor >= n && slot.entry["mode"] != "clone" {
                slot.cursor = None;
                continue;
            }
            if n == 0 {
                slot.cursor = None;
                continue;
            }
            let sample = clip.pcm.data[(cursor % n) / 3];
            slot.cursor = Some(cursor % n + 1);
            if cursor % 3 == 0 {
                let square = sample * sample;
                slot.energy.push_back(square);
                slot.sum += square;
                if slot.energy.len() > 1920 {
                    slot.sum -= slot.energy.pop_front().unwrap();
                }
            }
            for c in 0..2 {
                mixed[c] += sample * slot.gain[c];
            }
        }
        mixed
    }
    pub(super) fn talking(&self) -> Map<String, Value> {
        let mut map = Map::new();
        for ((owner, _), slot) in &self.slots {
            if slot.entry["mode"] != "clone"
                || slot.entry["spoofTalking"] != true
                || slot.cursor.is_none()
                || slot.gain == [0.; 2]
                || slot.energy.is_empty()
                || slot.sum / (slot.energy.len() as f32) < 0.008f32.powi(2)
            {
                continue;
            }
            if let Some(player) = self.state["players"].as_array().and_then(|ps| {
                ps.iter()
                    .find(|p| p["id"] == *owner && p["disconnected"] != true)
            }) {
                map.insert(player["clientId"].to_string(), json!(true));
            }
        }
        map
    }
    pub(super) fn requests(&mut self) -> Vec<(u64, u64, u64)> {
        std::mem::take(&mut self.requests)
    }
}
fn write(clip: &mut Recording, stamp: u64, raw: f32) {
    if let Some(index) = stamp
        .checked_sub(clip.start)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|i| *i < clip.pcm.data.len())
    {
        clip.pcm.data[index] = raw;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_parrot_roles_allocate_no_input_history_or_capture_targets() {
        let mut s = state(false);
        s["nosParrots"] = json!([]);
        let mut b = Bank::default();
        let budget = Arc::default();
        update(&mut b, &s, &budget, 10000, true);
        for i in 0..48000 {
            b.input(1, 0.5, 480000 + i, true);
        }
        assert!(b.inputs.is_empty());
        assert!(b.captures.is_empty());
        assert!(b.slots.is_empty());
        assert_eq!(budget.load(Ordering::Relaxed), 0);
    }
    fn state(clone: bool) -> Value {
        let entry = if clone {
            json!({"mode":"clone","spoofTalking":true,"ownerId":1,"birdId":1000001,"x":0.,"y":0.,"range":4.,"seconds":10.,"recordId":1,"sourceId":1,"started":10000,"clips":[1],"playId":0,"playClip":0,"playStarted":0})
        } else {
            json!({"ownerId":0,"birdId":1,"x":0.,"y":0.,"range":4.,"seconds":1.5,"recordId":1,"sourceId":1,"started":10000,"clips":[1],"playId":0,"playClip":0,"playStarted":0})
        };
        json!({"mod":"NoS","nosAddonIds":["tanuki.bcl.roles"],"lobbyCode":"ABCDEF","gameState":1,"isHost":true,"map":99,"closedDoors":[],"nosParrots":[entry],"players":[{"id":0,"clientId":10,"isLocal":true,"x":0.,"y":0.},{"id":1,"clientId":11,"x":0.,"y":0.}]})
    }
    fn update(bank: &mut Bank, state: &Value, budget: &Arc<AtomicUsize>, t: u64, audible: bool) {
        bank.update(
            state,
            &Preferences::default(),
            &json!({}),
            json!({"remote":{"clientId":11}}).as_object().unwrap(),
            &json!({}),
            &[],
            true,
            audible,
            t,
            budget,
        );
    }
    #[test]
    fn ten_second_clone_loops_and_spoof_tracks_pcm_without_network_vad() {
        let mut s = state(true);
        let mut b = Bank::default();
        let budget = Arc::default();
        update(&mut b, &s, &budget, 10000, true);
        assert_eq!(budget.load(Ordering::Relaxed), 160000 * 4);
        for i in 0..480000 {
            b.input(1, 0.5, 10000 * 48 + i, true);
        }
        s["nosParrots"][0]["playId"] = json!(1);
        s["nosParrots"][0]["playClip"] = json!(1);
        s["nosParrots"][0]["playStarted"] = json!(20000);
        // Owner's live microphone can be out of range/in a vent while clone plays.
        s["players"][1]["x"] = json!(100.);
        s["players"][1]["inVent"] = json!(true);
        update(&mut b, &s, &budget, 20000, true);
        for _ in 0..480010 {
            assert!(b.next(false)[0] > 0.3);
        }
        assert_eq!(b.talking()["11"], true);
        s["nosParrots"][0]["spoofTalking"] = json!(false);
        update(&mut b, &s, &budget, 30000, true);
        assert!(b.talking().is_empty());
        assert!(b.next(false)[0] > 0.3);
        b.next(true);
        assert!(b.talking().is_empty());
        s["nosParrots"] = json!([]);
        update(&mut b, &s, &budget, 30001, true);
        assert_eq!(budget.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn parrot_requests_near_live_raw_speech_and_never_recaptures_output() {
        let mut s = state(false);
        s["nosParrots"][0]["recordId"] = json!(0);
        s["nosParrots"][0]["clips"] = json!([]);
        let mut b = Bank::default();
        let budget = Arc::default();
        update(&mut b, &s, &budget, 10000, true);
        for i in 0..4800 {
            b.input(1, 0.5, 480000 + i, true);
        }
        assert_eq!(b.requests(), vec![(0, 1, 1)]);
        for _ in 0..48000 {
            b.next(false);
        }
        assert!(b.requests().is_empty());
        assert_eq!(budget.load(Ordering::Relaxed), 0);
        s["players"][1]["inVent"] = json!(true);
        update(&mut b, &s, &budget, 14000, true);
        for i in 0..4800 {
            b.input(1, 0.5, 14000 * 48 + i, true);
        }
        assert!(b.requests().is_empty());
    }
    #[test]
    fn muted_deafened_meeting_and_scope_removal_do_not_record() {
        let s = state(true);
        let mut b = Bank::default();
        let budget = Arc::default();
        update(&mut b, &s, &budget, 10000, true);
        for i in 0..4800 {
            b.input(1, 1., 480000 + i, false);
        }
        assert!(b.slots[&(1, 1000001)].clips[&1]
            .pcm
            .data
            .iter()
            .all(|v| *v == 0.));
        update(&mut b, &s, &budget, 10100, false);
        for i in 0..4800 {
            b.input(1, 1., 484800 + i, true);
        }
        assert!(b.slots[&(1, 1000001)].clips[&1]
            .pcm
            .data
            .iter()
            .all(|v| *v == 0.));
        let mut meeting = s.clone();
        meeting["gameState"] = json!(2);
        update(&mut b, &meeting, &budget, 10200, true);
        for i in 0..4800 {
            b.input(1, 1., 489600 + i, true);
        }
        assert!(b.slots[&(1, 1000001)].clips[&1]
            .pcm
            .data
            .iter()
            .all(|v| *v == 0.));
        b.clear();
        assert_eq!(budget.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn parrot_keeps_five_clips_and_plays_only_requested_recording() {
        let mut s = state(false);
        let mut b = Bank::default();
        let budget = Arc::default();
        for id in 1u64..=7 {
            let t = 10000 + (id - 1) * 2000;
            s["nosParrots"][0]["recordId"] = json!(id);
            s["nosParrots"][0]["started"] = json!(t);
            s["nosParrots"][0]["clips"] =
                json!(((id.saturating_sub(4)).max(1)..=id).collect::<Vec<_>>());
            update(&mut b, &s, &budget, t, true);
            for i in 0..72000 {
                b.input(1, id as f32 / 10., t * 48 + i, true);
            }
        }
        assert_eq!(b.slots[&(0, 1)].clips.len(), 5);
        assert_eq!(budget.load(Ordering::Relaxed), 5 * 24000 * 4);
        s["nosParrots"][0]["playId"] = json!(1);
        s["nosParrots"][0]["playClip"] = json!(5);
        s["nosParrots"][0]["playStarted"] = json!(24000);
        update(&mut b, &s, &budget, 24000, true);
        // The 150 ms pre-roll remains from the preceding raw speech history.
        for _ in 0..7201 {
            b.next(false);
        }
        assert!((b.next(false)[0] - 0.5 / std::f32::consts::SQRT_2).abs() < 0.001);
        for _ in 0..72000 {
            b.next(false);
        }
        assert_eq!(b.next(false), [0.; 2]);
    }
    #[test]
    fn comms_radio_and_missing_permission_block_capture() {
        let s = state(true);
        let mut b = Bank::default();
        let budget = Arc::default();
        b.update(
            &s,
            &Preferences::default(),
            &json!({}),
            json!({"r":{"clientId":11}}).as_object().unwrap(),
            &json!({}),
            &[11],
            true,
            true,
            10000,
            &budget,
        );
        for i in 0..4800 {
            b.input(1, 1., 480000 + i, true);
        }
        assert!(b.slots[&(1, 1000001)].clips[&1]
            .pcm
            .data
            .iter()
            .all(|v| *v == 0.));
        let mut comms = s.clone();
        comms["comsSabotaged"] = json!(true);
        b.update(
            &comms,
            &Preferences::default(),
            &json!({}),
            json!({"r":{"clientId":11}}).as_object().unwrap(),
            &json!({"commsSabotage":true}),
            &[],
            true,
            true,
            10000,
            &budget,
        );
        for i in 0..4800 {
            b.input(1, 1., 480000 + i, true);
        }
        assert!(b.slots[&(1, 1000001)].clips[&1]
            .pcm
            .data
            .iter()
            .all(|v| *v == 0.));
        b.update(
            &s,
            &Preferences::default(),
            &json!({}),
            &Map::new(),
            &json!({}),
            &[],
            false,
            true,
            10000,
            &budget,
        );
        assert_eq!(budget.load(Ordering::Relaxed), 0);
    }
}
