//! Release VAD (1024-bin Blackman FFT, 85–255 Hz, 0.2 smoothing, counter 5/30)
//! and 20 ms microphone release, independent of Web Audio timers.
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;
pub struct Vad {
    fft: Arc<dyn Fft<f32>>,
    samples: [f32; 1024],
    count: usize,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    previous: [f32; 512],
    counter: u8,
    pub active: bool,
}
impl Default for Vad {
    fn default() -> Self {
        let fft = FftPlanner::new().plan_fft_forward(1024);
        let scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
        Self {
            fft,
            samples: [0.0; 1024],
            count: 0,
            spectrum: vec![Complex32::default(); 1024],
            scratch,
            previous: [0.0; 512],
            counter: 0,
            active: false,
        }
    }
}
impl Vad {
    pub fn update(&mut self, samples: &[f32], sensitivity: f32) {
        for sample in samples {
            self.samples[self.count] = *sample;
            self.count += 1;
            if self.count != 1024 {
                continue;
            }
            self.count = 0;
            for n in 0..1024 {
                let phase = std::f32::consts::TAU * n as f32 / 1024.0;
                let window = 0.42 - 0.5 * phase.cos() + 0.08 * (phase * 2.0).cos();
                self.spectrum[n] = Complex32::new(self.samples[n] * window, 0.0);
            }
            self.fft
                .process_with_scratch(&mut self.spectrum, &mut self.scratch);
            let mut sum = 0.0;
            // round(85*1024/48000)=2, round(255*1024/48000)=5.
            for n in 2..5 {
                let magnitude = self.spectrum[n].norm() / 1024.0;
                self.previous[n] = 0.2 * self.previous[n] + 0.8 * magnitude;
                let db = 20.0 * self.previous[n].max(1e-20).log10();
                sum += (255.0 * ((db + 100.0) / 70.0).clamp(0.0, 1.0)).floor() / 255.0;
            }
            let level = sum / 3.0;
            let threshold =
                ((if sensitivity > 0.0 { sensitivity } else { 0.1 }) * 1.2).clamp(sensitivity, 1.0);
            if level >= threshold {
                self.counter = self.counter.saturating_add(1).min(30);
            } else {
                self.counter = self.counter.saturating_sub(1);
            }
            self.active = self.counter > 5;
        }
    }
}
#[derive(Default)]
pub struct Gate {
    open: bool,
    level: f32,
    release: usize,
    decrement: f32,
}
impl Gate {
    pub fn process(&mut self, sample: f32, open: bool) -> f32 {
        if open {
            self.level = 1.0;
            self.release = 0;
        } else if self.open {
            self.release = 960;
            self.decrement = self.level / 960.0;
        }
        self.open = open;
        let output = sample * self.level;
        if self.release > 0 {
            self.release -= 1;
            self.level = if self.release == 0 {
                0.0
            } else {
                (self.level - self.decrement).max(0.0)
            };
        }
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voiced_band_opens_and_silence_closes_the_release_vad() {
        let mut vad = Vad::default();
        let voice: Vec<_> = (0..48000)
            .map(|i| 0.1 * (std::f32::consts::TAU * 180.0 * i as f32 / 48000.0).sin())
            .collect();
        vad.update(&voice, 0.15);
        assert!(vad.active);
        vad.update(&vec![0.0; 48000], 0.15);
        assert!(!vad.active);
        vad.update(&voice, 1.0);
        assert!(!vad.active);
    }
    #[test]
    fn gate_releases_in_twenty_milliseconds_without_restarting_the_ramp() {
        let mut gate = Gate::default();
        assert_eq!(gate.process(1.0, false), 0.0);
        assert_eq!(gate.process(1.0, true), 1.0);
        let values: Vec<_> = (0..961).map(|_| gate.process(1.0, false)).collect();
        assert_eq!(values[0], 1.0);
        assert_eq!(values[960], 0.0);
        assert!(values.windows(2).all(|w| w[0] >= w[1]));
    }
}
