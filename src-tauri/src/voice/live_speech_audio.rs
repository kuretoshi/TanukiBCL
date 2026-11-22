use std::collections::VecDeque;

// Scheduling only; the native worker performs Silero VAD on every utterance.
#[derive(Default)]
pub struct LiveAudio {
    chunks: VecDeque<(u64, Vec<i16>)>,
    started: u64,
    voiced: u64,
    submitted: u64,
    last: u64,
    dirty: bool,
}
impl LiveAudio {
    pub fn append(&mut self, samples: &[i16], at: u64) {
        if samples.is_empty() || samples.len() > 16000 { return; }
        if self.last > 0 && at.saturating_sub(self.last) > 500 { *self = Self::default(); }
        self.last = at;
        let end = at + samples.len() as u64 / 16;
        let energy = samples.iter().map(|s| (*s as f64 / 32768.).powi(2)).sum::<f64>() / samples.len() as f64;
        self.chunks.push_back((at, samples.to_vec()));
        while self.chunks.front().is_some_and(|(t, s)| t + s.len() as u64 / 16 <= end.saturating_sub(8000)) { self.chunks.pop_front(); }
        if energy >= 0.000001 {
            if self.started == 0 { self.started = at; }
            self.voiced = end; self.dirty = true;
        }
        if self.started == 0 {
            while self.chunks.front().is_some_and(|(t, _)| *t <= end.saturating_sub(300)) { self.chunks.pop_front(); }
        }
    }
    pub fn take(&mut self, now: u64) -> Option<Vec<u8>> {
        if self.started == 0 || !self.dirty || now.saturating_sub(self.started) < 150 ||
            (now.saturating_sub(self.voiced) < 350 && now.saturating_sub(self.started.max(self.submitted)) < 1200) { return None; }
        let pcm: Vec<i16> = self.chunks.iter().flat_map(|(_, s)| s.iter().copied()).collect();
        self.submitted = now; self.dirty = false;
        let wav = crate::native::speech_audio::wav(&pcm);
        if now.saturating_sub(self.voiced) >= 350 { *self = Self::default(); }
        wav
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utterances_overlap_flush_once_and_remain_bounded() {
        let mut a = LiveAudio::default();
        for i in 0..12 { a.append(&vec![2000;1600], 1000+i*100); }
        assert!(a.take(2200).is_some()); assert!(a.take(2201).is_none());
        a.append(&vec![2000;1600],2200);
        assert!(a.take(2650).unwrap().len() > 40000);
        assert!(a.take(2800).is_none());
        for i in 0..300 { a.append(&vec![2000;1600],3000+i*100); }
        assert!(a.take(33000).unwrap().len() <= 44+16000*8*2);
    }
    #[test]
    fn silence_and_audio_gaps_cannot_replay_old_words() {
        let mut a=LiveAudio::default();
        for i in 0..30 {a.append(&vec![0;1600],1000+i*100);}
        assert!(a.take(5000).is_none());
        a.append(&vec![2000;3200],5000);a.append(&vec![0;3200],6000);
        assert!(a.take(6500).is_none());
    }
}
