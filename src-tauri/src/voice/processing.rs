//! Native 10 ms speech processing. Only this worker owns the APM; WASAPI
//! callbacks copy bounded blocks and never run the DSP or wait for networking.
use super::{
    audio::{Frame, SharedMixer},
    model::*,
};
use sonora::{
    config::{AdaptiveDigital, EchoCanceller, GainController2, HighPassFilter, NoiseSuppression},
    AudioProcessing, Config, StreamConfig,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub const BLOCK: usize = RATE as usize / 100;
pub type Block = [f32; BLOCK];
pub type Playback = [[f32; 2]; BLOCK];
pub struct Capture {
    pub samples: Block,
    pub captured_at: Instant,
}
pub struct Render {
    pub samples: [Block; 2],
    pub plays_at: Instant,
}

pub struct Processor {
    apm: Option<AudioProcessing>,
    echo: bool,
}
impl Processor {
    pub fn new(prefs: &Preferences) -> Self {
        let enabled = prefs.echo_cancellation || prefs.noise_suppression || prefs.auto_gain_control;
        let apm = enabled.then(|| {
            AudioProcessing::builder()
                .config(Config {
                    echo_canceller: prefs.echo_cancellation.then(EchoCanceller::default),
                    noise_suppression: prefs.noise_suppression.then(NoiseSuppression::default),
                    high_pass_filter: Some(HighPassFilter::default()),
                    gain_controller2: prefs.auto_gain_control.then(|| GainController2 {
                        // Digital gain only: never alter the Windows microphone level.
                        input_volume_controller: false,
                        adaptive_digital: Some(AdaptiveDigital {
                            max_gain_db: 20.0,
                            initial_gain_db: 0.0,
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                })
                .capture_config(StreamConfig::new(RATE, 1))
                .render_config(StreamConfig::new(RATE, 2))
                .build()
        });
        Self {
            apm,
            echo: prefs.echo_cancellation,
        }
    }
    pub fn render(&mut self, samples: &[Block; 2]) -> Result<(), String> {
        if self.echo {
            let mut scratch = [[0.0; BLOCK]; 2];
            let [left, right] = &mut scratch;
            self.apm
                .as_mut()
                .unwrap()
                .process_render_f32(&[&samples[0], &samples[1]], &mut [left, right])
                .map_err(|e| format!("エコー参照の処理: {e:?}"))?;
        }
        Ok(())
    }
    pub fn capture(&mut self, samples: &Block, delay_ms: i32) -> Result<Block, String> {
        let Some(apm) = &mut self.apm else {
            return Ok(*samples);
        };
        if self.echo {
            let _ = apm.set_stream_delay_ms(delay_ms.clamp(0, 500));
        }
        let mut out = [0.0; BLOCK];
        apm.process_capture_f32(&[samples], &mut [&mut out])
            .map_err(|e| format!("マイクの音声処理: {e:?}"))?;
        if out.iter().any(|s| !s.is_finite()) {
            return Err("音声処理で不正なサンプルを検出しました".into());
        }
        for value in &mut out {
            *value = value.clamp(-1.0, 1.0);
        }
        Ok(out)
    }
}

pub struct Worker {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Worker {
    pub fn start(
        prefs: Preferences,
        controls: Arc<Controls>,
        metrics: Arc<Metrics>,
        output: tokio::sync::mpsc::Sender<Frame>,
        errors: tokio::sync::mpsc::Sender<String>,
        mixer: SharedMixer,
    ) -> Result<
        (
            Self,
            SyncSender<Capture>,
            SyncSender<Render>,
            tokio::sync::mpsc::Receiver<Playback>,
        ),
        String,
    > {
        let (capture_tx, capture_rx) = mpsc::sync_channel(16);
        let (render_tx, render_rx) = mpsc::sync_channel(64);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (playback_tx, playback_rx) = tokio::sync::mpsc::channel(2);
        let stop = Arc::new(AtomicBool::new(false));
        let owned = stop.clone();
        let thread = std::thread::Builder::new()
            .name("voice-processing".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let processor = Processor::new(&prefs);
                    let _ = ready_tx.send(());
                    run(
                        processor,
                        &prefs,
                        owned,
                        capture_rx,
                        render_rx,
                        controls,
                        metrics,
                        output,
                        playback_tx,
                        mixer,
                    )
                }));
                match outcome {
                    Ok(Err(error)) => {
                        let _ = errors.try_send(error);
                    }
                    Err(_) => {
                        let _ = errors.try_send("音声処理が停止しました。再接続します".into());
                    }
                    _ => {}
                }
            })
            .map_err(|e| e.to_string())?;
        let worker = Self {
            stop,
            thread: Some(thread),
        };
        ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "音声処理を初期化できません")?;
        Ok((worker, capture_tx, render_tx, playback_rx))
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn run(
    mut processor: Processor,
    prefs: &Preferences,
    stop: Arc<AtomicBool>,
    capture: Receiver<Capture>,
    render: Receiver<Render>,
    controls: Arc<Controls>,
    metrics: Arc<Metrics>,
    output: tokio::sync::mpsc::Sender<Frame>,
    playback: tokio::sync::mpsc::Sender<Playback>,
    mixer: SharedMixer,
) -> Result<(), String> {
    let mut frame = [0.0; FRAME];
    let mut half = 0;
    let mut render_delay = Duration::ZERO;
    let mut overruns = (0, 0);
    while !stop.load(Ordering::Relaxed) {
        // At most 20 ms of pre-rendered audio. Mixer locks stay on this worker,
        // never on the WASAPI callback. Capacity follows the playback clock.
        while let Ok(permit) = playback.try_reserve() {
            let mut mix = mixer.lock().unwrap();
            let preview = controls.preview.lock().unwrap().render::<BLOCK>();
            let block = std::array::from_fn(|i| {
                let mut sample = mix.next(controls.deafened.load(Ordering::Relaxed));
                let test = super::audio::test_sample(&controls);
                for (ch, value) in sample.iter_mut().enumerate() {
                    *value = (*value + test + preview[i][ch]).clamp(-0.98, 0.98);
                }
                sample
            });
            drop(mix);
            permit.send(block);
        }
        let block = match capture.recv_timeout(Duration::from_millis(10)) {
            Ok(block) => block,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let observed = (
            metrics.capture_overruns.load(Ordering::Relaxed),
            metrics.reference_overruns.load(Ordering::Relaxed),
        );
        if observed != overruns {
            processor = Processor::new(prefs);
            overruns = observed;
            half = 0;
        }
        let start = Instant::now();
        for reference in render.try_iter().take(64) {
            render_delay = reference.plays_at.saturating_duration_since(Instant::now());
            processor.render(&reference.samples)?;
            metrics.reference.fetch_add(BLOCK as u64, Ordering::Relaxed);
        }
        let delay = (render_delay + block.captured_at.elapsed())
            .as_millis()
            .min(500) as i32;
        let processed = processor.capture(&block.samples, delay)?;
        let rms=(processed.iter().map(|&s|(s as f64)*(s as f64)).sum::<f64>()/processed.len() as f64).sqrt() as f32;
        controls.microphone_rms.store(rms.clamp(0.0,1.0).to_bits(),Ordering::Relaxed);
        controls.preview.lock().unwrap().capture(&processed);
        metrics
            .processing_nanos
            .fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
        metrics.processing_blocks.fetch_add(1, Ordering::Relaxed);
        metrics.processed.fetch_add(BLOCK as u64, Ordering::Relaxed);
        if !controls.joined.load(Ordering::Relaxed) {
            half = 0;
            continue;
        }
        let processed = if controls.transmitting(prefs.push_to_talk_mode) {
            processed
        } else {
            [0.0; BLOCK]
        };
        frame[half * BLOCK..(half + 1) * BLOCK].copy_from_slice(&processed);
        half += 1;
        if half == 2 {
            half = 0;
            // Before joining, capture/DSP continue but no stale speech is queued
            // behind a potentially slow signaling handshake.
            if controls.joined.load(Ordering::Relaxed) && output.try_send(frame).is_err() {
                metrics.dropped.fetch_add(FRAME as u64, Ordering::Relaxed);
            }
        }
    }
    Ok(())
}

fn disabled() -> Preferences {
    Preferences {
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain_control: false,
        ..Default::default()
    }
}
fn energy(block: &Block) -> f64 {
    block.iter().map(|&v| (v as f64).powi(2)).sum()
}
struct Noise(u32);
impl Noise {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32
    }
}
fn noise_ratio() -> Result<f64, String> {
    let mut p = Processor::new(&Preferences {
        noise_suppression: true,
        ..disabled()
    });
    let mut noise = Noise(12039);
    let (mut before, mut after) = (0.0, 0.0);
    for index in 0..800 {
        let source = std::array::from_fn(|_| noise.next() * 0.03);
        let output = p.capture(&source, 0)?;
        if index > 600 {
            before += energy(&source);
            after += energy(&output);
        }
    }
    Ok(after / before)
}
fn echo_ratio() -> Result<f64, String> {
    let mut p = Processor::new(&Preferences {
        echo_cancellation: true,
        ..disabled()
    });
    let mut noise = Noise(39173);
    let mut history = std::collections::VecDeque::from(vec![[0.0; BLOCK]; 8]);
    let (mut before, mut after) = (0.0, 0.0);
    for index in 0..1200 {
        let reference = std::array::from_fn(|_| noise.next() * 0.15);
        p.render(&[reference, reference])?;
        let delayed = history.pop_front().unwrap();
        history.push_back(reference);
        let source = delayed.map(|v| v * 0.55);
        let output = p.capture(&source, 80)?;
        if index > 900 {
            before += energy(&source);
            after += energy(&output);
        }
    }
    Ok(after / before)
}
fn gain_ratio() -> Result<f64, String> {
    let mut p = Processor::new(&Preferences {
        auto_gain_control: true,
        ..disabled()
    });
    let (mut before, mut after) = (0.0, 0.0);
    for index in 0..1200 {
        let source = std::array::from_fn(|i| {
            let time = (index * BLOCK + i) as f32 / RATE as f32;
            // A voiced, changing harmonic signal with syllabic amplitude.
            let pitch = 135.0 * time + 3.0 * (time * 2.1).sin();
            let syllable = (time * 2.5).fract();
            let envelope = if syllable < 0.65 {
                (std::f32::consts::PI * syllable / 0.65).sin().powi(2)
            } else {
                0.0
            };
            let vowel = ((time * 2.5) as usize) % 3;
            let (f1, f2) = [(600.0, 1200.0), (300.0, 2300.0), (400.0, 900.0)][vowel];
            let voiced: f32 = (1..=30)
                .map(|harmonic| {
                    let hz = harmonic as f32 * 135.0;
                    let formant = (-(hz - f1).powi(2) / 40000.0).exp()
                        + (-(hz - f2).powi(2) / 90000.0).exp() * 0.6;
                    (std::f32::consts::TAU * pitch * harmonic as f32).sin() * (0.05 + formant)
                        / harmonic as f32
                })
                .sum();
            voiced * 0.05 * envelope
        });
        let output = p.capture(&source, 0)?;
        if index > 900 {
            before += energy(&source);
            after += energy(&output);
        }
    }
    Ok(after / before)
}
pub fn diagnostics() -> Result<serde_json::Value, String> {
    let noise = noise_ratio()?;
    let echo = echo_ratio()?;
    let gain = gain_ratio()?;
    let report = serde_json::json!({"passed":noise<0.35&&echo<0.1&&gain>1.5,"engine":"sonora 0.2.0","sampleRate":RATE,"blockSamples":BLOCK,"syntheticSignals":true,"hardwareAudio":false,"audioSaved":false,"networkUsed":false,"noiseEnergyRatio":noise,"noiseReductionDb":-10.0*noise.log10(),"echoEnergyRatio":echo,"echoReductionDb":-10.0*echo.log10(),"gainEnergyRatio":gain,"gainDb":10.0*gain.log10()});
    if report["passed"] != true {
        return Err(format!("Speech processing validation failed: {report}"));
    }
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_processing_is_exact_passthrough() {
        let mut p = Processor::new(&disabled());
        let source = std::array::from_fn(|i| (i as f32 * 0.01).sin() * 0.2);
        assert_eq!(source, p.capture(&source, 0).unwrap());
    }
    #[test]
    fn stationary_noise_is_attenuated_after_adaptation() {
        let ratio = noise_ratio().unwrap();
        assert!(ratio < 0.35, "noise energy ratio {ratio}");
    }
    #[test]
    fn echo_reference_reduces_delayed_far_end_audio() {
        let ratio = echo_ratio().unwrap();
        assert!(ratio < 0.1, "echo energy ratio {ratio}");
    }
    #[test]
    fn agc_raises_low_speech_without_nonfinite_or_clipped_output() {
        let ratio = gain_ratio().unwrap();
        assert!(ratio > 1.5, "gain energy ratio {ratio}");
    }
    #[test]
    fn old_preferences_gain_defaults_without_losing_saved_values() {
        let p: Preferences =
            serde_json::from_str(r#"{"volume":0.4,"microphoneGain":0.7}"#).unwrap();
        assert!(p.echo_cancellation && p.noise_suppression && p.auto_gain_control);
        assert_eq!(p.volume, 0.4);
        assert_eq!(p.microphone_gain, 0.7);
    }
    #[test]
    fn worker_consumes_input_before_join_without_queuing_stale_speech() {
        let metrics = Arc::new(Metrics::default());
        let controls = Arc::new(Controls::default());
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let (errors, mut error_rx) = tokio::sync::mpsc::channel(4);
        let (worker, capture, _render, _playback) = Worker::start(
            disabled(),
            controls.clone(),
            metrics.clone(),
            tx,
            errors,
            Arc::new(std::sync::Mutex::new(super::super::audio::Mixer::default())),
        )
        .unwrap();
        for _ in 0..8 {
            capture
                .send(Capture {
                    samples: [0.3; BLOCK],
                    captured_at: Instant::now(),
                })
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while metrics.processed.load(Ordering::Relaxed) < (BLOCK * 8) as u64
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            metrics.processed.load(Ordering::Relaxed),
            (BLOCK * 8) as u64
        );
        assert!(rx.try_recv().is_err());
        controls.joined.store(true, Ordering::Relaxed);
        for _ in 0..4 {
            capture
                .send(Capture {
                    samples: [0.3; BLOCK],
                    captured_at: Instant::now(),
                })
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while metrics.processed.load(Ordering::Relaxed) < (BLOCK * 12) as u64
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            metrics.processed.load(Ordering::Relaxed),
            (BLOCK * 12) as u64
        );
        let mut count = 0;
        while rx.try_recv().is_ok() {
            count += 1;
        }
        assert_eq!(
            count, 2,
            "Joined local role recognition also receives capture before a peer connects"
        );
        controls.peers_ready.store(true, Ordering::Relaxed);
        controls.muted.store(true, Ordering::Relaxed);
        for _ in 0..2 {
            capture
                .send(Capture {
                    samples: [0.3; BLOCK],
                    captured_at: Instant::now(),
                })
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let frame = loop {
            if let Ok(frame) = rx.try_recv() {
                break frame;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(frame, [0.0; FRAME]);
        assert!(error_rx.try_recv().is_err());
        drop(worker);
    }
}
