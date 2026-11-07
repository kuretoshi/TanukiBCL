//! Rust port of the pinned sourceFilterProcessor.ts STFT/cepstral processor.
use rustfft::{num_complex::Complex64, Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
const N: usize = 2048;
const HOP: usize = 512;
const HALF: usize = N / 2;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Parameters {
    pub pitch: f64,
    pub formant: f64,
    pub squash: f64,
}
pub struct Processor {
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
    scratch: Vec<Complex64>,
    input: Vec<f64>,
    output: Vec<f64>,
    window: Vec<f64>,
    spectrum: Vec<Complex64>,
    cepstrum: Vec<Complex64>,
    magnitude: Vec<f64>,
    log_magnitude: Vec<f64>,
    envelope: Vec<f64>,
    last_phase: Vec<f64>,
    phase: Vec<f64>,
    weights: Vec<f64>,
    frequencies: Vec<f64>,
    excitation: Vec<f64>,
    cursor: usize,
    frames: usize,
    samples: usize,
    current: Parameters,
}
impl Default for Processor {
    fn default() -> Self {
        let mut planner = FftPlanner::new();
        let forward = planner.plan_fft_forward(N);
        let inverse = planner.plan_fft_inverse(N);
        let scratch = vec![
            Complex64::default();
            forward
                .get_inplace_scratch_len()
                .max(inverse.get_inplace_scratch_len())
        ];
        Self {
            forward,
            inverse,
            scratch,
            input: vec![0.0; N],
            output: vec![0.0; N],
            window: (0..N)
                .map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N as f64).cos())
                .collect(),
            spectrum: vec![Complex64::default(); N],
            cepstrum: vec![Complex64::default(); N],
            magnitude: vec![0.0; HALF + 1],
            log_magnitude: vec![0.0; HALF + 1],
            envelope: vec![0.0; HALF + 1],
            last_phase: vec![0.0; HALF + 1],
            phase: vec![0.0; HALF + 1],
            weights: vec![0.0; HALF + 1],
            frequencies: vec![0.0; HALF + 1],
            excitation: vec![0.0; HALF + 1],
            cursor: 0,
            frames: 0,
            samples: 0,
            current: Parameters {
                pitch: 1.0,
                formant: 1.0,
                squash: 0.0,
            },
        }
    }
}
fn interpolate(data: &[f64], position: f64) -> f64 {
    if position < 0.0 || position >= (data.len() - 1) as f64 {
        return data[(position.floor() as isize).clamp(0, data.len() as isize - 1) as usize];
    }
    let lo = position.floor() as usize;
    let fraction = position - lo as f64;
    data[lo] * (1.0 - fraction) + data[lo + 1] * fraction
}
pub fn limit(sample: f64) -> f64 {
    if !sample.is_finite() {
        0.0
    } else if sample.abs() <= 0.8 {
        sample
    } else {
        sample.signum() * (0.8 + 0.18 * ((sample.abs() - 0.8) / 0.18).tanh())
    }
}
impl Processor {
    fn frame(&mut self) {
        let step = std::f64::consts::TAU * HOP as f64 / N as f64;
        for i in 0..N {
            self.spectrum[i] = Complex64::new(self.input[i] * self.window[i], 0.0);
        }
        self.forward
            .process_with_scratch(&mut self.spectrum, &mut self.scratch);
        for k in 0..=HALF {
            self.magnitude[k] = self.spectrum[k].norm();
            self.log_magnitude[k] = self.magnitude[k].max(1e-6).ln();
            self.cepstrum[k] = Complex64::new(self.log_magnitude[k], 0.0);
            if k > 0 && k < HALF {
                self.cepstrum[N - k] = self.cepstrum[k];
            }
        }
        let lifter = (48000.0_f64 * 0.003).round().min(HALF as f64);
        for iteration in 0..4 {
            if iteration > 0 {
                for k in 0..=HALF {
                    self.cepstrum[k] =
                        Complex64::new(self.log_magnitude[k].max(self.cepstrum[k].re), 0.0);
                    if k > 0 && k < HALF {
                        self.cepstrum[N - k] = self.cepstrum[k];
                    }
                }
            }
            self.inverse
                .process_with_scratch(&mut self.cepstrum, &mut self.scratch);
            for i in 0..N {
                let distance = i.min(N - i) as f64;
                let gain = if i == 0 || distance <= lifter * 0.75 {
                    1.0
                } else if distance < lifter {
                    0.5 + 0.5 * (std::f64::consts::PI * (distance / lifter - 0.75) / 0.25).cos()
                } else {
                    0.0
                };
                self.cepstrum[i] = Complex64::new(self.cepstrum[i].re * gain / N as f64, 0.0);
            }
            self.forward
                .process_with_scratch(&mut self.cepstrum, &mut self.scratch);
        }
        for k in 0..=HALF {
            self.envelope[k] = self.cepstrum[k].re.clamp(-14.0, 14.0).exp();
        }
        self.weights.fill(0.0);
        self.frequencies.fill(0.0);
        self.excitation.fill(0.0);
        for k in 0..=HALF {
            let phase = self.spectrum[k].arg();
            let mut delta = phase - self.last_phase[k] - k as f64 * step;
            delta -= std::f64::consts::TAU * (delta / std::f64::consts::TAU + 0.5).floor();
            self.last_phase[k] = phase;
            if (self.current.pitch - 1.0).abs() < 1e-4 {
                continue;
            }
            let target = (k as f64 * self.current.pitch + 0.5).floor() as usize;
            if target > HALF {
                continue;
            }
            let weight = self.magnitude[k];
            self.excitation[target] += weight / self.envelope[k].max(1e-6);
            self.weights[target] += weight;
            self.frequencies[target] += (k as f64 + delta / step) * self.current.pitch * weight;
        }
        let (mut before, mut after) = (0.0, 0.0);
        let cutoff = 12000.0 * (900.0_f64 / 12000.0).powf(self.current.squash);
        for k in 0..=HALF {
            let filter = interpolate(&self.envelope, k as f64 / self.current.formant);
            let magnitude = if (self.current.pitch - 1.0).abs() < 1e-4 {
                self.phase[k] = self.last_phase[k];
                self.magnitude[k] * (filter / self.envelope[k].max(1e-6)).min(32.0)
            } else {
                let frequency = if self.weights[k] > 1e-9 {
                    self.frequencies[k] / self.weights[k]
                } else {
                    k as f64
                };
                self.phase[k] = (self.phase[k] + frequency * step) % std::f64::consts::TAU;
                (self.excitation[k] * filter)
                    .min(interpolate(&self.magnitude, k as f64 / self.current.pitch) * 32.0)
            };
            before += self.magnitude[k].powi(2);
            after += magnitude.powi(2);
            let muffle = if self.current.squash > 0.0 {
                1.0 / (1.0 + ((k as f64 * 48000.0 / N as f64) / cutoff).powi(4)).sqrt()
            } else {
                1.0
            };
            self.spectrum[k] = Complex64::from_polar(magnitude * muffle, self.phase[k]);
            if k > 0 && k < HALF {
                self.spectrum[N - k] = self.spectrum[k].conj();
            }
        }
        self.spectrum[0].im = 0.0;
        self.spectrum[HALF].im = 0.0;
        let gain = (before / after.max(1e-12)).sqrt().min(1.0) * (1.0 - 0.3 * self.current.squash);
        self.inverse
            .process_with_scratch(&mut self.spectrum, &mut self.scratch);
        for i in 0..N {
            self.output[i] += self.spectrum[i].re / N as f64 * self.window[i] * gain
                / (N as f64 / HOP as f64 * 0.375);
        }
        self.input.copy_within(HOP..N, 0);
        self.input[N - HOP..].fill(0.0);
        self.frames += 1;
    }
    pub fn process(&mut self, sample: [f32; 2], parameters: Parameters) -> [f32; 2] {
        self.input[N - HOP + self.cursor] = (sample[0] as f64 + sample[1] as f64) * 0.5;
        let wet = limit(self.output[self.cursor]) as f32;
        let blend = ((self.samples as f32 - N as f32) / 480.0).clamp(0.0, 1.0);
        let result = sample.map(|dry| dry * (1.0 - blend) + wet * blend);
        self.samples += 1;
        self.cursor += 1;
        if self.cursor == HOP {
            self.output.copy_within(HOP..N, 0);
            self.output[N - HOP..].fill(0.0);
            if self.frames == 0 {
                self.current = parameters;
            } else {
                let smoothing = 1.0 - (-(HOP as f64) / (48000.0 * 0.04)).exp();
                self.current.pitch += smoothing * (parameters.pitch - self.current.pitch);
                self.current.formant += smoothing * (parameters.formant - self.current.formant);
                self.current.squash += smoothing * (parameters.squash - self.current.squash);
            }
            self.frame();
            self.cursor = 0;
        }
        result
    }
}
