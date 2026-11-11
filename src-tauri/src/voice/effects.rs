//! Bounded native replacements for the Vanilla Web Audio effect chain.
//! Biquad coefficients and impulse normalization follow the Web Audio spec:
//! https://www.w3.org/TR/webaudio/#filters-characteristics
//! https://www.w3.org/TR/webaudio/#dom-convolvernode-normalize
use super::routing::{Effects, Filter};
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::{Arc, OnceLock};
const N: usize = 512;
const FFT: usize = N * 2;

pub struct Biquad {
    coefficients: [f64; 5],
    history: [[f64; 2]; 2],
}
impl Biquad {
    pub fn new(filter: Filter) -> Self {
        let w = std::f64::consts::TAU * filter.frequency / 48000.0;
        let cos = w.cos();
        let alpha = w.sin() / (2.0 * 10_f64.powf(filter.q / 20.0));
        let b0 = if filter.highpass {
            (1.0 + cos) / 2.0
        } else {
            (1.0 - cos) / 2.0
        };
        let b1 = if filter.highpass {
            -(1.0 + cos)
        } else {
            1.0 - cos
        };
        let a0 = 1.0 + alpha;
        Self {
            coefficients: [
                b0 / a0,
                b1 / a0,
                b0 / a0,
                -2.0 * cos / a0,
                (1.0 - alpha) / a0,
            ],
            history: [[0.0; 2]; 2],
        }
    }
    pub fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let [b0, b1, b2, a1, a2] = self.coefficients;
        std::array::from_fn(|ch| {
            let x = input[ch] as f64;
            let h = &mut self.history[ch];
            let y = b0 * x + h[0];
            h[0] = b1 * x - a1 * y + h[1];
            h[1] = b2 * x - a2 * y;
            if y.is_finite() {
                y as f32
            } else {
                *h = [0.0; 2];
                0.0
            }
        })
    }
}
struct Kernel {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    spectra: [Vec<Vec<Complex32>>; 2],
}
impl Kernel {
    fn new(impulse: &[[f32; 2]]) -> Self {
        let mut planner = FftPlanner::new();
        let forward = planner.plan_fft_forward(FFT);
        let inverse = planner.plan_fft_inverse(FFT);
        let spectra = std::array::from_fn(|ch| {
            impulse
                .chunks(N)
                .map(|block| {
                    let mut data = vec![Complex32::default(); FFT];
                    for (n, sample) in block.iter().enumerate() {
                        data[n].re = sample[ch];
                    }
                    forward.process(&mut data);
                    data
                })
                .collect()
        });
        Self {
            forward,
            inverse,
            spectra,
        }
    }
}
fn kernel() -> Arc<Kernel> {
    static KERNEL: OnceLock<Arc<Kernel>> = OnceLock::new();
    KERNEL
        .get_or_init(|| {
            let bytes = include_bytes!("../../audio/reverb-48000.f32");
            let impulse: Vec<_> = bytes
                .chunks_exact(8)
                .map(|b| {
                    [
                        f32::from_le_bytes(b[..4].try_into().unwrap()),
                        f32::from_le_bytes(b[4..].try_into().unwrap()),
                    ]
                })
                .collect();
            Arc::new(Kernel::new(&impulse))
        })
        .clone()
}
struct Convolver {
    kernel: Arc<Kernel>,
    history: [Vec<Vec<Complex32>>; 2],
    input: [[f32; 2]; N],
    output: [[f32; 2]; N],
    overlap: [[f32; 2]; N],
    sum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    position: usize,
    cursor: usize,
}
impl Convolver {
    fn new(kernel: Arc<Kernel>) -> Self {
        let partitions = kernel.spectra[0].len();
        let scratch = vec![
            Complex32::default();
            kernel
                .forward
                .get_inplace_scratch_len()
                .max(kernel.inverse.get_inplace_scratch_len())
        ];
        Self {
            kernel,
            history: std::array::from_fn(|_| vec![vec![Complex32::default(); FFT]; partitions]),
            input: [[0.0; 2]; N],
            output: [[0.0; 2]; N],
            overlap: [[0.0; 2]; N],
            sum: vec![Complex32::default(); FFT],
            scratch,
            position: 0,
            cursor: 0,
        }
    }
    fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let output = self.output[self.position];
        self.input[self.position] = input;
        self.position += 1;
        if self.position == N {
            self.position = 0;
            for ch in 0..2 {
                let data = &mut self.history[ch][self.cursor];
                data.fill(Complex32::default());
                for (n, sample) in self.input.iter().enumerate() {
                    data[n].re = sample[ch];
                }
                self.kernel
                    .forward
                    .process_with_scratch(data, &mut self.scratch);
                self.sum.fill(Complex32::default());
                let count = self.history[ch].len();
                for (part, spectrum) in self.kernel.spectra[ch].iter().enumerate() {
                    let previous = &self.history[ch][(self.cursor + count - part) % count];
                    for n in 0..FFT {
                        self.sum[n] += previous[n] * spectrum[n];
                    }
                }
                self.kernel
                    .inverse
                    .process_with_scratch(&mut self.sum, &mut self.scratch);
                for n in 0..N {
                    self.output[n][ch] = self.sum[n].re / FFT as f32 + self.overlap[n][ch];
                    self.overlap[n][ch] = self.sum[n + N].re / FFT as f32;
                }
            }
            self.cursor = (self.cursor + 1) % self.history[0].len();
        }
        output
    }
}
struct Echo {
    delay: Vec<[f32; 2]>,
    cursor: usize,
    dry: f32,
    wet: f32,
    feedback: f32,
}
impl Echo {
    fn new() -> Self {
        Self {
            delay: vec![[0.0; 2]; 4320],
            cursor: 0,
            dry: 0.92,
            wet: 0.2,
            feedback: 0.12,
        }
    }
    fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let delayed = self.delay[self.cursor];
        self.delay[self.cursor] = std::array::from_fn(|ch| input[ch] + delayed[ch] * self.feedback);
        self.cursor = (self.cursor + 1) % self.delay.len();
        std::array::from_fn(|ch| input[ch] * self.dry + delayed[ch] * self.wet)
    }
}
struct Berserker {
    high: Biquad,
    low: Biquad,
    previous: [f32; 2],
    gain: f64,
    amount: f32,
}
impl Default for Berserker {
    fn default() -> Self {
        Self {
            high: Biquad::new(Filter {
                highpass: true,
                frequency: 80.0,
                q: std::f64::consts::FRAC_1_SQRT_2,
            }),
            low: Biquad::new(Filter {
                highpass: false,
                frequency: 4200.0,
                q: std::f64::consts::FRAC_1_SQRT_2,
            }),
            previous: [0.0; 2],
            gain: 1.0,
            amount: 0.0,
        }
    }
}
fn shape(x: f32) -> f32 {
    static CURVE: OnceLock<Vec<f32>> = OnceLock::new();
    let curve = CURVE.get_or_init(|| {
        (0..4096)
            .map(|i| {
                (5.0_f64 * (2.0 * i as f64 / 4095.0 - 1.0)).tanh() as f32 / 5.0_f64.tanh() as f32
            })
            .collect()
    });
    let position = (x.clamp(-1.0, 1.0) + 1.0) * 0.5 * 4095.0;
    let first = position.floor() as usize;
    let second = (first + 1).min(4095);
    curve[first] + (curve[second] - curve[first]) * (position - first as f32)
}
impl Berserker {
    fn process(&mut self, input: [f32; 2], amount: f64) -> [f32; 2] {
        let high = self.high.process(input);
        let shaped = std::array::from_fn(|ch| {
            (1..=4)
                .map(|i| {
                    shape(self.previous[ch] + (high[ch] - self.previous[ch]) * (i as f32 / 4.0))
                })
                .sum::<f32>()
                * 0.25
        });
        self.previous = high;
        let low = self.low.process(shaped);
        let mix: [f32; 2] = std::array::from_fn(|ch| high[ch] * 0.8 + low[ch] * 0.12);
        let level = 20.0_f64 * (mix[0].abs().max(mix[1].abs()) as f64).max(1e-12).log10();
        let threshold = -14.0;
        let knee = 12.0;
        let reduced = if level < threshold - knee * 0.5 {
            0.0
        } else if level > threshold + knee * 0.5 {
            (threshold + (level - threshold) / 3.0) - level
        } else {
            (1.0 / 3.0 - 1.0) * (level - threshold + knee * 0.5).powi(2) / (2.0 * knee)
        };
        let target = 10.0_f64.powf(reduced / 20.0);
        let coefficient =
            (-1.0_f64 / (48000.0 * if target < self.gain { 0.005 } else { 0.08 })).exp();
        self.gain = target + (self.gain - target) * coefficient;
        self.amount += (amount as f32 - self.amount) * (1.0 - (-1.0_f32 / (48000.0 * 0.01)).exp());
        std::array::from_fn(|ch| {
            input[ch] * (1.0 - self.amount) + mix[ch] * self.gain as f32 * 0.78 * self.amount
        })
    }
}
#[derive(Default)]
pub struct Processor {
    config: Effects,
    pitch: Option<super::pitch::Processor>,
    berserker: Option<Berserker>,
    tuning_echo: Option<Echo>,
    filter: Option<Biquad>,
    convolver: Option<Convolver>,
    echo: Option<Echo>,
}
impl Processor {
    pub fn configure(&mut self, config: Effects) {
        if config.berserker > 0.0 {
            self.berserker.get_or_insert_with(Berserker::default);
        } else {
            self.berserker = None;
        }
        if config.pitch.is_some() != self.config.pitch.is_some() {
            self.pitch = config.pitch.map(|_| super::pitch::Processor::default());
        }
        if config.echo > 0.0 {
            let echo = self.tuning_echo.get_or_insert_with(|| Echo {
                delay: vec![[0.0; 2]; 8640],
                cursor: 0,
                dry: 1.0,
                wet: 0.0,
                feedback: 0.22,
            });
            echo.wet = 0.12 * config.echo as f32;
        } else {
            self.tuning_echo = None;
        }
        if config.filter != self.config.filter {
            self.filter = config.filter.map(Biquad::new);
        }
        if config.reverb != self.config.reverb {
            self.convolver = config.reverb.then(|| Convolver::new(kernel()));
        }
        if config.radio_echo != self.config.radio_echo {
            self.echo = config.radio_echo.then(Echo::new);
        }
        self.config = config;
    }
    pub fn process(&mut self, mut sample: [f32; 2]) -> [f32; 2] {
        if let Some(pitch) = &mut self.pitch {
            sample = pitch.process(sample, self.config.pitch.unwrap());
        }
        if let Some(berserker) = &mut self.berserker {
            sample = berserker.process(sample, self.config.berserker);
        }
        if let Some(echo) = &mut self.tuning_echo {
            sample = echo.process(sample);
        }
        if let Some(filter) = &mut self.filter {
            sample = filter.process(sample);
        }
        if let Some(convolver) = &mut self.convolver {
            let wet = convolver.process(sample);
            sample = std::array::from_fn(|ch| {
                sample[ch] * (1.0 - self.config.reverb_wet as f32)
                    + wet[ch] * self.config.reverb_wet as f32
            });
        }
        if let Some(echo) = &mut self.echo {
            sample = echo.process(sample);
        }
        if self.config.reverb
            || self.config.pitch.is_some()
            || self.config.echo > 0.0
            || self.config.berserker > 0.0
        {
            sample = sample.map(|x| {
                if x.abs() <= 0.8 {
                    x
                } else {
                    x.signum() * (0.8 + 0.18 * ((x.abs() - 0.8) / 0.18).tanh())
                }
            });
        }
        sample
    }
}
pub fn probe(input: &std::path::Path, output: &std::path::Path) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Case {
        effects: Effects,
        samples: Vec<[f32; 2]>,
    }
    if std::fs::metadata(input).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("Effect input is too large".into());
    }
    let cases: Vec<Case> =
        serde_json::from_slice(&std::fs::read(input).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if cases.len() > 16 || cases.iter().any(|c| c.samples.len() > 96000) {
        return Err("Too many effect samples".into());
    }
    let mut results = Vec::new();
    for case in cases {
        if case
            .samples
            .iter()
            .flatten()
            .any(|x| !x.is_finite() || x.abs() > 4.0)
        {
            return Err("Invalid generated input".into());
        }
        if case.effects.pitch.is_some_and(|p| {
            !p.pitch.is_finite()
                || !(0.4..=2.0).contains(&p.pitch)
                || !p.formant.is_finite()
                || !(0.55..=1.7).contains(&p.formant)
                || !p.squash.is_finite()
                || !(0.0..=1.0).contains(&p.squash)
        }) {
            return Err("Invalid pitch parameters".into());
        }
        if case.effects.filter.is_some_and(|p| {
            !p.frequency.is_finite()
                || !(10.0..=20000.0).contains(&p.frequency)
                || !p.q.is_finite()
                || !(-30.0..=30.0).contains(&p.q)
        }) {
            return Err("Invalid filter parameters".into());
        }
        if !case.effects.echo.is_finite()
            || !(0.0..=1.0).contains(&case.effects.echo)
            || !case.effects.reverb_wet.is_finite()
            || !(0.0..=1.0).contains(&case.effects.reverb_wet)
            || !case.effects.berserker.is_finite()
            || !(0.0..=1.0).contains(&case.effects.berserker)
        {
            return Err("Invalid effect mix".into());
        }
        let mut processor = Processor::default();
        processor.configure(case.effects);
        results.push(
            case.samples
                .into_iter()
                .map(|s| processor.process(s))
                .collect::<Vec<_>>(),
        );
    }
    std::fs::write(
        output,
        serde_json::to_vec(&results).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn berserker_remains_finite_for_full_scale_speech_and_releases_when_disabled() {
        let mut p = Processor::default();
        p.configure(Effects {
            berserker: 1.0,
            ..Default::default()
        });
        let mut energy = 0.0;
        for n in 0..96000 {
            let x = (n as f32 * std::f32::consts::TAU * 180.0 / 48000.0).sin() * 0.9;
            let result = p.process([x, x * 0.5]);
            assert!(result.iter().all(|x| x.is_finite() && x.abs() <= 0.981));
            if n > 48000 {
                energy += result[0] * result[0];
            }
        }
        assert!(energy > 100.0);
        p.configure(Effects::default());
        assert!(p.berserker.is_none());
        assert_eq!(p.process([0.25, -0.25]), [0.25, -0.25]);
    }
    #[test]
    fn partitioned_convolution_matches_direct_convolution_and_has_bounded_delay() {
        let impulse: Vec<_> = (0..1300)
            .map(|n| [(n as f32 * 0.2).cos() * (-0.01 * n as f32).exp(), 0.01])
            .collect();
        let mut conv = Convolver::new(Arc::new(Kernel::new(&impulse)));
        for n in 0usize..2400 {
            let result = conv.process(if n == 0 { [1.0; 2] } else { [0.0; 2] });
            let expected = n
                .checked_sub(N)
                .and_then(|i| impulse.get(i))
                .copied()
                .unwrap_or([0.0; 2]);
            assert!(
                result
                    .iter()
                    .zip(expected)
                    .all(|(a, b)| (a - b).abs() < 1e-5),
                "sample {n}: {result:?} {expected:?}"
            );
        }
    }
    #[test]
    fn radio_echo_uses_release_delay_feedback_and_mix() {
        let mut echo = Echo::new();
        for n in 0..8641 {
            let result = echo.process(if n == 0 { [1.0; 2] } else { [0.0; 2] });
            let expected = match n {
                0 => 0.92,
                4320 => 0.2,
                8640 => 0.024,
                _ => 0.0,
            };
            assert!((result[0] - expected).abs() < 1e-6);
        }
    }
    #[test]
    fn disabling_effects_releases_buffers_and_drops_tail() {
        let mut p = Processor::default();
        p.configure(Effects {
            filter: None,
            reverb: true,
            radio_echo: true,
            reverb_wet: 1.0,
            ..Default::default()
        });
        p.process([1.0; 2]);
        p.configure(Effects::default());
        assert!(p.convolver.is_none() && p.echo.is_none());
        assert_eq!(p.process([0.0; 2]), [0.0; 2]);
    }
}
