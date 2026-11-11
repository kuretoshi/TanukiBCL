//! Bounded native audio queues. No IPC, encoding, disk I/O or blocking lock in
//! a WASAPI callback. Received audio is never saved to disk.
use super::{
    model::*,
    processing::{Capture, Playback, Render, Worker, BLOCK},
};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SizedSample,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

pub type Frame = [f32; FRAME];
pub type SharedMixer = Arc<Mutex<Mixer>>;
const CHIME: &[u8] = include_bytes!("../../audio/chime-48000.f32");
const RADIO: &[u8] = include_bytes!("../../audio/radio-48000.f32");
pub const RADIO_FRAMES: usize = RADIO.len() / 4;
pub const CHIME_FRAMES: usize = CHIME.len() / 4;
pub fn test_sample(controls: &Controls) -> f32 {
    cue_sample(&controls.speaker_test, CHIME, 0.25) + cue_sample(&controls.radio_cue, RADIO, 0.02)
}
fn cue_sample(counter: &std::sync::atomic::AtomicU64, bytes: &[u8], volume: f32) -> f32 {
    let remaining = counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
        .unwrap_or(0) as usize;
    if remaining == 0 || remaining > bytes.len() / 4 {
        return 0.0;
    }
    let i = (bytes.len() / 4 - remaining) * 4;
    f32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) * volume
}
pub struct Source {
    queue: VecDeque<[f32; 2]>,
    pub target: [f32; 2],
    current: [f32; 2],
    effects: super::effects::Processor,
    mono: bool,
    stereo_target: [[f32; 2]; 2],
    stereo_current: [[f32; 2]; 2],
    body: Option<super::rokuro::Body>,
}
#[derive(Default)]
pub struct Mixer {
    sources: HashMap<String, Source>,
    pub recordings: super::recordings::Book,
    pub speech: Option<super::speech::Sender>,
}
impl Mixer {
    pub fn add(&mut self, id: &str) {
        if self.sources.len() < MAX_PEERS {
            self.sources.entry(id.to_owned()).or_insert_with(|| Source {
                queue: VecDeque::with_capacity(QUEUE_FRAMES),
                target: [0.0; 2],
                current: [0.0; 2],
                effects: super::effects::Processor::default(),
                mono: true,
                stereo_target: [[0.0; 2]; 2],
                stereo_current: [[0.0; 2]; 2],
                body: None,
            });
        }
    }
    pub fn remove(&mut self, id: &str) {
        self.sources.remove(id);
    }
    pub fn clear(&mut self) {
        self.sources.clear();
        self.recordings.clear();
        self.speech = None;
    }
    pub fn gain(&mut self, id: &str, gain: [f32; 2]) {
        if let Some(s) = self.sources.get_mut(id) {
            s.target = gain;
            s.stereo_target = [[gain[0], 0.0], [0.0, gain[1]]];
            // A newly blocked route must not fade audible speech through a wall.
            if gain == [0.0; 2] {
                s.current = [0.0; 2];
                s.stereo_current = [[0.0; 2]; 2];
            }
        }
    }
    pub fn route(&mut self, id: &str, route: super::routing::Route) {
        self.gain(id, route.gains);
        if let Some(source) = self.sources.get_mut(id) {
            source.stereo_target = route.stereo;
            source.effects.configure(route.effects);
        }
    }
    pub fn body(&mut self, id: &str, route: Option<(super::routing::Route, f32)>) {
        if let Some(source) = self.sources.get_mut(id) {
            match route {
                Some((r, e)) => {
                    if let Some(body) = &mut source.body {
                        body.update(r, e);
                    } else {
                        source.body = Some(super::rokuro::Body::new(r, e));
                    }
                }
                None => source.body = None,
            }
        }
    }
    pub fn push_channels(&mut self, id: &str, pcm: &[f32], metrics: &Metrics, mono: bool) {
        if let Some(source) = self.sources.get_mut(id) {
            source.mono = mono;
        }
        self.push(id, pcm, metrics);
    }
    pub fn push(&mut self, id: &str, pcm: &[f32], metrics: &Metrics) {
        let Some(s) = self.sources.get_mut(id) else {
            return;
        };
        let incoming = pcm.len() / 2;
        let overflow = (s.queue.len() + incoming).saturating_sub(QUEUE_FRAMES);
        for _ in 0..overflow.min(s.queue.len()) {
            s.queue.pop_front();
        }
        metrics
            .dropped
            .fetch_add(overflow as u64, Ordering::Relaxed);
        for pair in pcm
            .chunks_exact(2)
            .skip(incoming.saturating_sub(QUEUE_FRAMES))
        {
            s.queue.push_back([pair[0], pair[1]]);
        }
        if let Some(speech) = &self.speech {
            speech.push(
                id,
                &pcm.chunks_exact(2)
                    .map(|p| (p[0] + p[1]) * 0.5)
                    .collect::<Vec<_>>(),
            );
        }
    }
    pub(super) fn next(&mut self, muted: bool) -> [f32; 2] {
        let mut mixed = [0.0f32; 2];
        for (id, s) in &mut self.sources {
            let sample = s.queue.pop_front().unwrap_or([0.0; 2]);
            let scaled = std::array::from_fn(|ch| {
                s.current[ch] += (s.target[ch] - s.current[ch]) * 0.004;
                for input in 0..2 {
                    s.stereo_current[ch][input] +=
                        (s.stereo_target[ch][input] - s.stereo_current[ch][input]) * 0.004;
                }
                if s.mono {
                    sample[0] * s.current[ch]
                } else {
                    sample[0] * s.stereo_current[ch][0] + sample[1] * s.stereo_current[ch][1]
                }
            });
            let processed = s.effects.process(scaled);
            let extra = self
                .recordings
                .peer(id, (sample[0] + sample[1]) * 0.5, scaled, !muted);
            if !muted {
                for ch in 0..2 {
                    mixed[ch] += extra[ch];
                }
            }
            if let Some(body) = &mut s.body {
                let secondary = body.next(sample, s.mono);
                if !muted {
                    for ch in 0..2 {
                        mixed[ch] += secondary[ch];
                    }
                }
            }
            if !muted && s.target != [0.0; 2] {
                for ch in 0..2 {
                    mixed[ch] += processed[ch];
                }
            }
        }
        let interviews = self.recordings.next(muted);
        for ch in 0..2 {
            mixed[ch] += interviews[ch];
        }
        for x in &mut mixed {
            *x = x.clamp(-0.98, 0.98);
        }
        mixed
    }
}

/// A streaming linear resampler used only at the hardware boundary. Codec/RTP
/// always uses 48kHz. Fractional state survives every hardware callback.
pub struct Resampler {
    ratio: f64,
    phase: f64,
    previous: f32,
}
impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self {
            ratio: to as f64 / from as f64,
            phase: 0.0,
            previous: 0.0,
        }
    }
    pub fn push(&mut self, sample: f32, mut output: impl FnMut(f32)) {
        self.phase += self.ratio;
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            let fraction = (1.0 - self.phase / self.ratio) as f32;
            output(self.previous + (sample - self.previous) * fraction);
        }
        self.previous = sample;
    }
}

pub fn devices() -> Result<Value, String> {
    let host = cpal::default_host();
    let list = |input: bool| -> Result<Value, String> {
        let all = if input {
            host.input_devices()
        } else {
            host.output_devices()
        }
        .map_err(|e| e.to_string())?;
        Ok(Value::Array(
            all.take(64)
                .filter_map(|d| {
                    Some(json!({"id":d.id().ok()?.to_string(),"name":d.description().ok()?.name()}))
                })
                .collect(),
        ))
    };
    Ok(json!({"inputs":list(true)?,"outputs":list(false)?}))
}
fn device(id: &str, input: bool) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if !id.is_empty() && id != "default" {
        if let Some(device) = id.parse().ok().and_then(|id| host.device_by_id(&id)) {
            return Ok(device);
        }
    }
    // Chromium IDs and unplugged devices cannot be used by WASAPI. Follow the
    // system default until the user chooses a currently available native ID.
    (if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    })
    .ok_or_else(|| {
        if input {
            "マイクが見つかりません".into()
        } else {
            "出力デバイスが見つかりません".into()
        }
    })
}

pub struct Audio {
    _input: Option<cpal::Stream>,
    _output: Option<cpal::Stream>,
    _processor: Option<Worker>,
    pub input_name: String,
    pub output_name: String,
}
impl Audio {
    pub fn start(
        prefs: &Preferences,
        mixer: SharedMixer,
        controls: Arc<Controls>,
        metrics: Arc<Metrics>,
        tx: mpsc::Sender<Frame>,
        errors: mpsc::Sender<String>,
        synthetic: bool,
    ) -> Result<Self, String> {
        if synthetic {
            return Ok(Self {
                _input: None,
                _output: None,
                _processor: None,
                input_name: "Synthetic test source (no microphone)".into(),
                output_name: "Bounded test sink (no speaker)".into(),
            });
        }
        let input = device(&prefs.microphone, true)?;
        let output = device(&prefs.speaker, false)?;
        let input_name = input
            .description()
            .map_err(|e| e.to_string())?
            .name()
            .to_owned();
        let output_name = output
            .description()
            .map_err(|e| e.to_string())?
            .name()
            .to_owned();
        let in_config = input.default_input_config().map_err(|e| e.to_string())?;
        let out_config = output.default_output_config().map_err(|e| e.to_string())?;
        let (processor, capture_tx, render_tx, playback_rx) = Worker::start(
            prefs.clone(),
            controls.clone(),
            metrics.clone(),
            tx,
            errors.clone(),
            mixer.clone(),
        )?;
        macro_rules! input {
            ($t:ty) => {
                input_stream::<$t>(
                    &input,
                    in_config.config(),
                    capture_tx,
                    metrics.clone(),
                    errors.clone(),
                )
            };
        }
        let capture = match in_config.sample_format() {
            cpal::SampleFormat::F32 => input!(f32),
            cpal::SampleFormat::F64 => input!(f64),
            cpal::SampleFormat::I16 => input!(i16),
            cpal::SampleFormat::I32 => input!(i32),
            cpal::SampleFormat::U16 => input!(u16),
            other => return Err(format!("未対応のマイク形式: {other}")),
        }
        .map_err(|e| format!("マイクを開けません: {e}"))?;
        macro_rules! output {
            ($t:ty) => {
                output_stream::<$t>(
                    &output,
                    out_config.config(),
                    playback_rx,
                    controls,
                    metrics,
                    errors,
                    render_tx,
                )
            };
        }
        let playback = match out_config.sample_format() {
            cpal::SampleFormat::F32 => output!(f32),
            cpal::SampleFormat::F64 => output!(f64),
            cpal::SampleFormat::I16 => output!(i16),
            cpal::SampleFormat::I32 => output!(i32),
            cpal::SampleFormat::U16 => output!(u16),
            other => return Err(format!("未対応の再生形式: {other}")),
        }
        .map_err(|e| format!("再生デバイスを開けません: {e}"))?;
        capture.play().map_err(|e| e.to_string())?;
        playback.play().map_err(|e| e.to_string())?;
        Ok(Self {
            _input: Some(capture),
            _output: Some(playback),
            _processor: Some(processor),
            input_name,
            output_name,
        })
    }
}
fn input_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    tx: std::sync::mpsc::SyncSender<Capture>,
    metrics: Arc<Metrics>,
    errors: mpsc::Sender<String>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut resampler = Resampler::new(config.sample_rate, RATE);
    let mut frame = [0.0; BLOCK];
    let mut position = 0;
    let mut captured_at = Instant::now();
    let native_rate = config.sample_rate;
    let error_metrics = metrics.clone();
    device.build_input_stream(
        config,
        move |data: &[T], info| {
            let stamp = info.timestamp();
            let capture_base = Instant::now()
                .checked_sub(stamp.callback.duration_since(stamp.capture))
                .unwrap_or_else(Instant::now);
            for (index, sample) in data.chunks_exact(channels).enumerate() {
                let mono =
                    sample.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / channels as f32;
                resampler.push(mono, |sample| {
                    if position == 0 {
                        captured_at = capture_base
                            + Duration::from_secs_f64(index as f64 / native_rate as f64);
                    }
                    frame[position] = if sample.is_finite() {
                        sample.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    };
                    position += 1;
                    if position == BLOCK {
                        metrics.captured.fetch_add(BLOCK as u64, Ordering::Relaxed);
                        if tx
                            .try_send(Capture {
                                samples: frame,
                                captured_at,
                            })
                            .is_err()
                        {
                            metrics.dropped.fetch_add(BLOCK as u64, Ordering::Relaxed);
                            metrics.capture_overruns.fetch_add(1, Ordering::Relaxed);
                        }
                        position = 0;
                    }
                });
            }
        },
        move |e| {
            stream_error(e, true, &error_metrics, &errors);
        },
        Some(Duration::from_secs(5)),
    )
}
fn output_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut playback: mpsc::Receiver<Playback>,
    controls: Arc<Controls>,
    metrics: Arc<Metrics>,
    errors: mpsc::Sender<String>,
    reference: std::sync::mpsc::SyncSender<Render>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let step = RATE as f64 / config.sample_rate as f64;
    let mut phase = 0.0;
    let mut current = [0.0; 2];
    let mut next = [0.0; 2];
    let mut playback_block = [[0.0; 2]; BLOCK];
    let mut playback_position = BLOCK;
    let mut render = [[0.0; BLOCK]; 2];
    let mut render_position = 0;
    let mut plays_at = Instant::now();
    let native_rate = config.sample_rate;
    let error_metrics = metrics.clone();
    device.build_output_stream(
        config,
        move |data: &mut [T], info| {
            let stamp = info.timestamp();
            let playback_base = Instant::now() + stamp.playback.duration_since(stamp.callback);
            let deafened = controls.deafened.load(Ordering::Relaxed);
            let mut energy = 0.0f64;
            for (index, frame) in data.chunks_exact_mut(channels).enumerate() {
                let value = if deafened {
                    [0.0; 2]
                } else {
                    [
                        current[0] + (next[0] - current[0]) * phase as f32,
                        current[1] + (next[1] - current[1]) * phase as f32,
                    ]
                };
                for (ch, sample) in frame.iter_mut().enumerate() {
                    let v = if channels == 1 {
                        (value[0] + value[1]) * 0.5
                    } else if ch < 2 {
                        value[ch]
                    } else {
                        0.0
                    };
                    *sample = T::from_sample(v);
                    energy += (v * v) as f64;
                }
                phase += step;
                while phase >= 1.0 {
                    phase -= 1.0;
                    current = next;
                    if playback_position == BLOCK {
                        playback_block = playback.try_recv().unwrap_or_else(|_| {
                            metrics.playback_underruns.fetch_add(1, Ordering::Relaxed);
                            [[0.0; 2]; BLOCK]
                        });
                        playback_position = 0;
                    }
                    next = playback_block[playback_position];
                    playback_position += 1;
                    if render_position == 0 {
                        plays_at = playback_base
                            + Duration::from_secs_f64(index as f64 / native_rate as f64);
                    }
                    let sample = if deafened {
                        [0.0; 2]
                    } else if channels == 1 {
                        [(next[0] + next[1]) * 0.5; 2]
                    } else {
                        next
                    };
                    render[0][render_position] = sample[0];
                    render[1][render_position] = sample[1];
                    render_position += 1;
                    if render_position == BLOCK {
                        if reference
                            .try_send(Render {
                                samples: render,
                                plays_at,
                            })
                            .is_err()
                        {
                            metrics.reference_overruns.fetch_add(1, Ordering::Relaxed);
                        }
                        render_position = 0;
                    }
                }
            }
            metrics
                .rendered
                .fetch_add((data.len() / channels) as u64, Ordering::Relaxed);
            metrics
                .output_energy
                .fetch_add((energy * 1_000_000.0) as u64, Ordering::Relaxed);
        },
        move |e| {
            stream_error(e, false, &error_metrics, &errors);
        },
        Some(Duration::from_secs(5)),
    )
}
fn stream_error(error: cpal::Error, input: bool, metrics: &Metrics, errors: &mpsc::Sender<String>) {
    // CPAL keeps these streams active. Rebuilding on an initial WASAPI
    // discontinuity would repeat the same startup glitch every three seconds.
    match error.kind() {
        cpal::ErrorKind::Xrun => {
            if input {
                &metrics.device_capture_xruns
            } else {
                &metrics.device_playback_xruns
            }
            .fetch_add(1, Ordering::Relaxed);
        }
        cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::RealtimeDenied => {}
        _ => {
            let _ = errors.try_send(format!(
                "{}: {error}",
                if input { "マイク" } else { "再生" }
            ));
        }
    }
}
pub fn drain_test_sink(mixer: &SharedMixer, controls: &Controls, metrics: &Metrics) {
    let mut mix = mixer.lock().unwrap();
    let mut energy = 0.0f64;
    for _ in 0..FRAME {
        let s = mix.next(controls.deafened.load(Ordering::Relaxed));
        energy += (s[0] * s[0] + s[1] * s[1]) as f64;
    }
    metrics.rendered.fetch_add(FRAME as u64, Ordering::Relaxed);
    metrics
        .output_energy
        .fetch_add((energy * 1_000_000.0) as u64, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recoverable_device_notifications_do_not_restart_voice_but_disconnects_do() {
        let metrics = Metrics::default();
        let (tx, mut rx) = mpsc::channel(4);
        for kind in [
            cpal::ErrorKind::Xrun,
            cpal::ErrorKind::DeviceChanged,
            cpal::ErrorKind::RealtimeDenied,
        ] {
            stream_error(kind.into(), true, &metrics, &tx);
        }
        assert!(rx.try_recv().is_err());
        assert_eq!(metrics.device_capture_xruns.load(Ordering::Relaxed), 1);
        stream_error(
            cpal::ErrorKind::DeviceNotAvailable.into(),
            true,
            &metrics,
            &tx,
        );
        assert!(rx.try_recv().unwrap().starts_with("マイク:"));
        stream_error(cpal::ErrorKind::Xrun.into(), false, &metrics, &tx);
        assert!(rx.try_recv().is_err());
        assert_eq!(metrics.device_playback_xruns.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn resampling_survives_callback_boundaries() {
        let mut r = Resampler::new(44100, 48000);
        let mut out = Vec::new();
        for i in 0..44100 {
            r.push((i as f32 * 0.01).sin(), |s| out.push(s));
        }
        assert!((out.len() as i32 - 48000).abs() <= 1);
        assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
    }
    #[test]
    fn queues_are_bounded_and_deafen_consumes_audio() {
        let m = Metrics::default();
        let mut mix = Mixer::default();
        mix.add("a");
        mix.gain("a", [1.0; 2]);
        for _ in 0..100 {
            mix.push("a", &vec![0.1; FRAME * 2], &m);
        }
        assert_eq!(mix.sources["a"].queue.len(), QUEUE_FRAMES);
        for _ in 0..100 {
            assert_eq!(mix.next(true), [0.0; 2]);
        }
        assert_eq!(mix.sources["a"].queue.len(), QUEUE_FRAMES - 100);
        assert!(mix.next(false)[0] > 0.0);
        mix.remove("a");
        assert!(mix.sources.is_empty());
    }
    #[test]
    fn blocked_route_mutes_queued_audio_without_a_fade_tail() {
        let mut mix = Mixer::default();
        let metrics = Metrics::default();
        mix.add("a");
        mix.gain("a", [1.0; 2]);
        mix.push("a", &vec![0.1; FRAME * 2], &metrics);
        assert!(mix.next(false)[0] > 0.0);
        mix.gain("a", [0.0; 2]);
        for _ in 0..FRAME {
            assert_eq!(mix.next(false), [0.0; 2]);
        }
    }
}
