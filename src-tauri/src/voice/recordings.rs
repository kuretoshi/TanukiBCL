//! Listener-local, lazy role recordings. PCM stays in RAM and is released on
//! room/role removal. A shared budget bounds simultaneous addon recordings.
use super::{
    effects::{Biquad, Processor},
    model::*,
    routing::{Effects, Filter},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
const RATE: usize = 48000;
const BUDGET: usize = 192 * 1024 * 1024;
fn clock() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Clip {
    data: Vec<f32>,
    limit: usize,
    budget: Arc<AtomicUsize>,
}
impl Clip {
    fn new(limit: usize, budget: &Arc<AtomicUsize>, zeroed: bool) -> Option<Self> {
        let bytes = limit.checked_mul(4)?;
        budget
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                n.checked_add(bytes).filter(|n| *n <= BUDGET)
            })
            .ok()?;
        let mut data = Vec::with_capacity(limit);
        if zeroed {
            data.resize(limit, 0.);
        }
        Some(Self {
            data,
            limit,
            budget: budget.clone(),
        })
    }
    fn push(&mut self, v: f32) {
        if self.data.len() < self.limit {
            self.data.push(v);
        }
    }
}
impl Drop for Clip {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.limit * 4, Ordering::Relaxed);
    }
}
struct Playback {
    clip: Arc<Clip>,
    at: usize,
    looped: bool,
}
impl Playback {
    fn next(&mut self) -> Option<f32> {
        if self.clip.data.is_empty() {
            return None;
        }
        if self.at >= self.clip.data.len() {
            if !self.looped {
                return None;
            }
            self.at = 0;
        }
        let v = self.clip.data[self.at];
        self.at += 1;
        Some(v)
    }
}
struct Dying {
    started: u64,
    until: u64,
    clip: Option<Clip>,
    retained: Option<Arc<Clip>>,
    play: Option<Playback>,
    inside: bool,
    looped: bool,
    high: Biquad,
    low: Biquad,
}
impl Dying {
    fn new(v: &Value, budget: &Arc<AtomicUsize>, t: u64) -> Self {
        let started = v["started"].as_u64().unwrap_or(0);
        let seconds = number(v, "seconds", 0.).clamp(0., 30.);
        let until = started + (seconds * 1000.) as u64;
        Self {
            started,
            until,
            clip: if t < until {
                Clip::new((seconds * RATE as f64) as usize, budget, false)
            } else {
                None
            },
            retained: None,
            play: None,
            inside: false,
            looped: flag(v, "loop"),
            high: Biquad::new(Filter {
                highpass: true,
                frequency: 400.,
                q: 1.,
            }),
            low: Biquad::new(Filter {
                highpass: false,
                frequency: 3000.,
                q: 1.,
            }),
        }
    }
    fn update(&mut self, near: bool, t: u64) {
        if !near {
            self.inside = false;
            self.play = None;
        } else if t >= self.until && !self.inside {
            self.inside = true;
            if self.retained.is_none() {
                self.retained = self
                    .clip
                    .take()
                    .filter(|c| !c.data.is_empty())
                    .map(Arc::new);
            }
            self.play = self.retained.clone().map(|clip| Playback {
                clip,
                at: 0,
                looped: self.looped,
            });
        }
    }
    fn sample(&mut self, raw: f32, stamp: u64) -> f32 {
        if stamp < self.until * 48 {
            if let Some(clip) = &mut self.clip {
                clip.push(raw);
            }
        }
        let Some(p) = &mut self.play else { return 0. };
        let Some(v) = p.next() else {
            self.play = None;
            return 0.;
        };
        self.low.process(self.high.process([v; 2]))[0]
    }
}
struct Mega {
    shot: u64,
    fired: u64,
    recording: bool,
    clip: Option<Clip>,
    play: Option<Playback>,
    delay: Vec<f32>,
    delay_at: usize,
    filter: Biquad,
    effect: bool,
    tail: usize,
}
impl Mega {
    fn new() -> Self {
        Self {
            shot: 0,
            fired: 0,
            recording: false,
            clip: None,
            play: None,
            delay: Vec::new(),
            delay_at: 0,
            filter: Biquad::new(Filter {
                highpass: false,
                frequency: 3500.,
                q: 1.,
            }),
            effect: false,
            tail: 0,
        }
    }
    fn update(&mut self, v: Option<&Value>, budget: &Arc<AtomicUsize>) {
        let Some(v) =
            v.filter(|v| v["phase"].is_string() && v["shotId"].as_u64().is_some_and(|n| n > 0))
        else {
            self.recording = false;
            self.clip = None;
            return;
        };
        let shot = v["shotId"].as_u64().unwrap();
        if shot != self.shot {
            *self = Self::new();
            self.shot = shot;
        }
        if v["phase"] == "charging" {
            self.recording = self.fired != shot;
            if self.recording && self.clip.is_none() {
                self.clip = Clip::new(RATE * 10, budget, false);
            }
            return;
        }
        if self.fired == shot {
            return;
        }
        self.fired = shot;
        self.recording = false;
        self.play = self
            .clip
            .take()
            .filter(|c| !c.data.is_empty())
            .map(|clip| Playback {
                clip: Arc::new(clip),
                at: 0,
                looped: false,
            });
        self.effect = v["voiceEffect"] != false;
        if self.effect && self.play.is_some() {
            self.delay = vec![0.; 11520];
            self.tail = RATE * 24 / 10;
        }
    }
    fn sample(&mut self, raw: f32, allowed: bool) -> f32 {
        if self.recording {
            if let Some(c) = &mut self.clip {
                c.push(if allowed { raw } else { 0. });
            }
        }
        let input = self.play.as_mut().and_then(Playback::next);
        if input.is_none() {
            self.play = None;
            if self.tail == 0 {
                self.delay = Vec::new();
                return 0.;
            }
            self.tail -= 1;
        }
        let v = input.unwrap_or(0.);
        if self.delay.is_empty() {
            return 0.7 * v;
        }
        let delayed = self.delay[self.delay_at];
        let filtered = self.filter.process([delayed; 2])[0];
        self.delay[self.delay_at] = v + filtered * 0.48;
        self.delay_at = (self.delay_at + 1) % self.delay.len();
        let wet = if input.is_some() {
            0.3
        } else {
            0.3 * (0.001f32 / 0.3).powf(1. - self.tail as f32 / (RATE as f32 * 2.4))
        };
        0.7 * v + filtered * wet
    }
    fn silence(&mut self) {
        self.play = None;
        self.tail = 0;
        self.delay = Vec::new();
    }
}
struct Echo {
    delay: Vec<[f32; 2]>,
    at: usize,
    alive: bool,
    seen: u64,
    until: u64,
    strength: f32,
    fx: Processor,
}
impl Echo {
    fn new() -> Self {
        Self {
            delay: vec![[0.; 2]; 14400],
            at: 0,
            alive: false,
            seen: 0,
            until: 0,
            strength: 1.,
            fx: Processor::default(),
        }
    }
    fn update(&mut self, dead: bool, event: u64, t: u64, tuning: super::roles::Tuning) {
        if dead
            && self.alive
            && event != 0
            && event != self.seen
            && t.saturating_sub(event) <= 1500
            && event <= t + 100
        {
            self.seen = event;
            self.until = t * 48 + 115200;
        }
        if !dead {
            self.alive = true;
        }
        self.strength = tuning.echo as f32 / 100.;
        self.fx.configure(if self.until > t * 48 {
            Effects {
                pitch: (tuning.pitch != 0.).then_some(super::pitch::Parameters {
                    pitch: 2f64.powf(tuning.pitch / 100.),
                    formant: 1.,
                    squash: 0.,
                }),
                reverb: tuning.reverb > 0.,
                reverb_wet: tuning.reverb / 100.,
                ..Default::default()
            }
        } else {
            Effects::default()
        });
    }
    fn sample(&mut self, live: [f32; 2], dead: bool, stamp: u64) -> [f32; 2] {
        let delayed = self.delay[self.at];
        let feedback = if self.until > stamp {
            0.56 * self.strength
        } else {
            0.56
        };
        self.delay[self.at] = std::array::from_fn(|c| {
            if dead {
                delayed[c] * feedback
            } else {
                live[c] + delayed[c] * feedback
            }
        });
        self.at = (self.at + 1) % self.delay.len();
        if self.until <= stamp {
            return [0.; 2];
        }
        let gain = 0.65 * (0.001f32 / 0.65).powf(1. - (self.until - stamp) as f32 / 115200.);
        let result = self.fx.process(delayed);
        std::array::from_fn(|c| result[c] * gain)
    }
}
struct Peer {
    player: u64,
    dead: bool,
    allowed: bool,
    volume: f32,
    dying: Option<Dying>,
    mega: Option<Mega>,
    echo: Option<Echo>,
}
impl Peer {
    fn new(player: u64) -> Self {
        Self {
            player,
            dead: false,
            allowed: false,
            volume: 0.,
            dying: None,
            mega: None,
            echo: None,
        }
    }
}
struct Interview {
    entry: Value,
    clip: Clip,
    handled: u64,
    play_at: Option<usize>,
    peak: f32,
}
#[derive(Default)]
pub struct Book {
    scope: String,
    peers: HashMap<String, Peer>,
    interviews: HashMap<u64, Interview>,
    budget: Arc<AtomicUsize>,
    stamp: u64,
    volume: f32,
    local_audio: VecDeque<(f32, bool, u64)>,
}
impl Book {
    pub fn clear(&mut self) {
        self.scope.clear();
        self.peers.clear();
        self.interviews.clear();
        self.local_audio.clear();
        self.stamp = clock() * 48;
    }
    pub fn update(
        &mut self,
        state: &Value,
        prefs: &Preferences,
        shared: &Value,
        clients: &serde_json::Map<String, Value>,
        permitted: bool,
        audible: bool,
    ) {
        let t = clock();
        self.stamp = t * 48;
        let active = super::roles::addon(state)
            && matches!(state["gameState"].as_i64(), Some(1 | 2))
            && permitted;
        let scope = format!("{}:{}", state["lobbyCode"], active);
        if self.scope != scope {
            self.clear();
            self.scope = scope;
        }
        if !active {
            return;
        }
        self.volume = prefs.volume;
        let Some(me) = local(state) else {
            self.clear();
            return;
        };
        let mut keep = HashSet::new();
        for (key, player) in clients
            .iter()
            .map(|(key, c)| {
                (
                    key.clone(),
                    state["players"]
                        .as_array()
                        .and_then(|ps| ps.iter().find(|p| p["clientId"] == c["clientId"])),
                )
            })
            .chain(std::iter::once(("local".to_string(), Some(me))))
        {
            let Some(p) = player.filter(|p| !flag(p, "disconnected")) else {
                continue;
            };
            let id = p["id"].as_u64().unwrap_or(256);
            if id > 255 {
                continue;
            }
            keep.insert(key.clone());
            let config = player_config(shared, p);
            let slot = self
                .peers
                .entry(key.clone())
                .or_insert_with(|| Peer::new(id));
            slot.player = id;
            slot.dead = flag(p, "isDead");
            slot.allowed = config["isMuted"] != true;
            slot.volume = if slot.allowed {
                (number(config, "volume", 1.).clamp(0., 2.) as f32) * prefs.volume
            } else {
                0.
            };
            let entry = |name: &str| {
                state[name]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|v| v["playerId"] == id))
            };
            if key != "local" && slot.dead {
                if let Some(v) = entry("nosDyingVoices") {
                    if slot
                        .dying
                        .as_ref()
                        .is_none_or(|d| v["started"] != d.started)
                    {
                        slot.dying = Some(Dying::new(v, &self.budget, t));
                    }
                    let near = state["gameState"] == 1
                        && !flag(me, "isDead")
                        && (number(me, "x", 1e9) - number(v, "x", 0.))
                            .hypot(number(me, "y", 1e9) - number(v, "y", 0.))
                            <= number(v, "range", 0.);
                    slot.dying.as_mut().unwrap().update(near && audible, t);
                } else {
                    slot.dying = None;
                }
            } else {
                slot.dying = None;
            }
            if state["gameState"] == 1 && audible && slot.allowed {
                if entry("nosMegaphones").is_some() || slot.mega.is_some() {
                    slot.mega
                        .get_or_insert_with(Mega::new)
                        .update(entry("nosMegaphones"), &self.budget);
                }
            } else {
                slot.mega = None;
            }
            let tuning = super::roles::configured(shared, "nosBibiri");
            if key != "local"
                && slot.allowed
                && (tuning.pitch != 0. || tuning.echo > 0. || tuning.reverb > 0.)
            {
                let event = entry("nosBibiriEchoes")
                    .and_then(|e| e["unixMs"].as_u64())
                    .unwrap_or(0);
                slot.echo
                    .get_or_insert_with(Echo::new)
                    .update(slot.dead, event, t, tuning);
            } else {
                slot.echo = None;
            }
        }
        self.peers.retain(|k, _| keep.contains(k));
        let entries: Vec<_> = state["nosInterviews"]
            .as_array()
            .into_iter()
            .flatten()
            .take(32)
            .collect();
        let retained: HashSet<_> = entries
            .iter()
            .filter_map(|v| v["playerId"].as_u64())
            .collect();
        self.interviews.retain(|id, _| retained.contains(id));
        for entry in entries {
            let Some(id) = entry["playerId"].as_u64() else {
                continue;
            };
            let started = entry["started"].as_u64().unwrap_or(0);
            let seconds = number(entry, "seconds", 0.);
            if started == 0 || !(1.0..=30.).contains(&seconds) {
                continue;
            }
            if self
                .interviews
                .get(&id)
                .is_some_and(|s| s.entry["started"] != started)
            {
                self.interviews.remove(&id);
            }
            if !self.interviews.contains_key(&id) {
                let Some(clip) =
                    Clip::new((seconds * RATE as f64).ceil() as usize, &self.budget, true)
                else {
                    continue;
                };
                self.interviews.insert(
                    id,
                    Interview {
                        entry: entry.clone(),
                        clip,
                        handled: entry["playStarted"].as_u64().unwrap_or(0),
                        play_at: None,
                        peak: 1.,
                    },
                );
            }
            let slot = self.interviews.get_mut(&id).unwrap();
            slot.entry = entry.clone();
            let play = entry["playStarted"].as_u64().unwrap_or(0);
            if state["gameState"] == 2 {
                if play > 0 && play != slot.handled {
                    slot.handled = play;
                    let duration = entry["stopped"]
                        .as_u64()
                        .unwrap_or(started)
                        .saturating_sub(started);
                    let offset = t.saturating_sub(play);
                    slot.play_at = (duration > offset).then_some((offset * 48) as usize);
                    slot.peak = slot.clip.data.iter().fold(1f32, |p, v| p.max(v.abs()));
                }
            } else {
                slot.play_at = None;
                slot.handled = play;
            }
        }
    }
    fn interview_input(&mut self, player: u64, raw: f32, stamp: u64) {
        for slot in self.interviews.values_mut() {
            if !slot.entry["visible"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| *id == player))
            {
                continue;
            }
            let start = slot.entry["started"].as_u64().unwrap_or(0) * 48;
            let stopped = slot.entry["stopped"].as_u64().unwrap_or(0) * 48;
            if stopped > 0 && stamp >= stopped {
                continue;
            }
            if let Some(index) = stamp
                .checked_sub(start)
                .and_then(|i| usize::try_from(i).ok())
                .filter(|i| *i < slot.clip.data.len())
            {
                slot.clip.data[index] += raw;
            }
        }
    }
    pub fn local(&mut self, frame: &[f32], allowed: bool) {
        let stamp = clock() * 48;
        if !self.peers.contains_key("local") {
            return;
        }
        while self.local_audio.len() + frame.len() > 7680 {
            self.local_audio.pop_front();
        }
        for (i, v) in frame.iter().enumerate() {
            self.local_audio
                .push_back((if allowed { *v } else { 0. }, allowed, stamp + i as u64));
        }
    }
    fn input(
        &mut self,
        key: &str,
        raw: f32,
        live: [f32; 2],
        stamp: u64,
        audible: bool,
    ) -> [f32; 2] {
        let Some(peer) = self.peers.get_mut(key) else {
            return [0.; 2];
        };
        let mut mixed = [0.; 2];
        let id = peer.player;
        let allowed = peer.allowed;
        let dying = peer.dying.as_mut().map_or(0., |d| d.sample(raw, stamp));
        let mega = peer.mega.as_mut().map_or(0., |m| m.sample(raw, allowed));
        let echo = peer
            .echo
            .as_mut()
            .map_or([0.; 2], |e| e.sample(live, peer.dead, stamp));
        for c in 0..2 {
            mixed[c] = (dying + mega) * peer.volume + echo[c];
        }
        if allowed && audible {
            self.interview_input(id, raw, stamp);
        }
        mixed
    }
    pub fn peer(&mut self, key: &str, raw: f32, live: [f32; 2], audible: bool) -> [f32; 2] {
        self.input(key, raw, live, self.stamp, audible)
    }
    pub fn next(&mut self, muted: bool) -> [f32; 2] {
        self.stamp += 1;
        let local = self
            .local_audio
            .pop_front()
            .map(|(raw, allowed, stamp)| {
                self.input(
                    "local",
                    if allowed { raw } else { 0. },
                    [0.; 2],
                    stamp,
                    allowed && !muted,
                )
            })
            .unwrap_or([0.; 2]);
        let mut v = 0.;
        for slot in self.interviews.values_mut() {
            if muted {
                slot.play_at = None;
                continue;
            }
            if let Some(at) = slot.play_at {
                let count = slot.entry["stopped"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_sub(slot.entry["started"].as_u64().unwrap_or(0))
                    * 48;
                if at < slot.clip.data.len() && at < (count as usize) {
                    v += slot.clip.data[at] / slot.peak * self.volume;
                    slot.play_at = Some(at + 1);
                } else {
                    slot.play_at = None;
                }
            }
        }
        if muted {
            for peer in self.peers.values_mut() {
                if let Some(m) = &mut peer.mega {
                    m.silence();
                }
                if let Some(d) = &mut peer.dying {
                    d.play = None;
                }
                peer.echo = None;
            }
            [0.; 2]
        } else {
            [v + local[0], v + local[1]]
        }
    }
    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.budget.load(Ordering::Relaxed)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_book_uses_no_pcm_and_shared_budget_is_released() {
        let b = Book::default();
        assert_eq!(b.bytes(), 0);
        {
            let _clip = Clip::new(48000, &b.budget, true).unwrap();
            assert_eq!(b.bytes(), 192000);
            assert!(Clip::new(BUDGET / 4, &b.budget, false).is_none());
        }
        assert_eq!(b.bytes(), 0);
    }
    #[test]
    fn late_dying_state_cannot_record_later_ghost_speech() {
        let budget = Arc::default();
        let mut d = Dying::new(
            &serde_json::json!({"started":1000,"seconds":1}),
            &budget,
            3000,
        );
        for _ in 0..200 {
            d.sample(1., 3000 * 48);
        }
        assert!(d.clip.is_none());
        d.update(true, 3000);
        assert!(d.play.is_none());
    }
    #[test]
    fn megaphone_fires_once_and_preserves_charge_until_playback() {
        let budget = Arc::default();
        let mut m = Mega::new();
        let mut v = serde_json::json!({"shotId":1,"phase":"charging","voiceEffect":false});
        m.update(Some(&v), &budget);
        for _ in 0..32 {
            m.sample(0.5, true);
        }
        v["phase"] = serde_json::json!("firing");
        m.update(Some(&v), &budget);
        assert!((m.sample(0., true) - 0.35).abs() < 1e-6);
        for _ in 0..40 {
            m.sample(0., true);
        }
        m.update(Some(&v), &budget);
        assert_eq!(m.sample(0., true), 0.);
    }
    #[test]
    fn interview_visibility_and_time_window_reject_unseen_audio() {
        let mut b = Book::default();
        let entry = serde_json::json!({"started":1000,"stopped":1100,"visible":[1]});
        let clip = Clip::new(48000, &b.budget, true).unwrap();
        b.interviews.insert(
            1,
            Interview {
                entry,
                clip,
                handled: 0,
                play_at: None,
                peak: 1.,
            },
        );
        b.interview_input(2, 1., 1000 * 48);
        b.interview_input(1, 0.4, 1000 * 48);
        b.interview_input(1, 1., 1100 * 48);
        assert_eq!(b.interviews[&1].clip.data[0], 0.4);
        assert_eq!(b.interviews[&1].clip.data[4800], 0.);
    }
}
