//! Ignore only expected initialization failures before the first valid snapshot.
use std::time::{Duration, Instant};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub(super) struct Startup {
    process: Option<(u32, Instant)>,
    ready: bool,
}

impl Startup {
    pub fn observe(&mut self, pid: Option<u32>, now: Instant) {
        if self.process.map(|(pid, _)| pid) != pid {
            self.process = pid.map(|pid| (pid, now));
            self.ready = false;
        }
    }

    pub fn ready(&mut self) {
        self.ready = true;
    }

    pub fn waiting(&self, error: &str, now: Instant) -> bool {
        !self.ready
            && self.process.is_some_and(|(_, started)| {
                now.saturating_duration_since(started) < STARTUP_TIMEOUT
            })
            && matches!(
                error,
                "GameAssembly.dll の読み込みを待っています"
                    | "ゲームのパレット読み込みを待っています"
                    | "ゲームメモリの読み取りに失敗しました"
                    | "Invalid game read"
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_reads_wait_but_permissions_offsets_and_lobby_failures_remain_errors() {
        let now = Instant::now();
        let mut startup = Startup::default();
        startup.observe(Some(123), now);
        for error in [
            "GameAssembly.dll の読み込みを待っています",
            "ゲームのパレット読み込みを待っています",
            "ゲームメモリの読み取りに失敗しました",
            "Invalid game read",
        ] {
            assert!(startup.waiting(error, now + Duration::from_secs(30)));
        }
        for error in [
            "ゲームを読み取れません: アクセスが拒否されました",
            "ゲームのオフセットを取得できません。ネットワーク接続を確認してください。",
            "ゲームのシグネチャが見つかりません。互換モードを利用してください。",
            "ゲームのプレイヤー構造を読み取れません",
            "Unsupported Vanilla palette",
        ] {
            assert!(!startup.waiting(error, now));
        }
        startup.ready();
        assert!(!startup.waiting("ゲームメモリの読み取りに失敗しました", now));
    }

    #[test]
    fn retries_do_not_extend_the_deadline_and_a_new_process_gets_its_own_startup() {
        let now = Instant::now();
        let mut startup = Startup::default();
        let error = "ゲームメモリの読み取りに失敗しました";
        assert!(!startup.waiting(error, now));
        startup.observe(Some(123), now);
        startup.observe(Some(123), now + Duration::from_secs(119));
        assert!(startup.waiting(error, now + Duration::from_secs(119)));
        assert!(!startup.waiting(error, now + STARTUP_TIMEOUT));
        startup.observe(Some(124), now + STARTUP_TIMEOUT);
        assert!(startup.waiting(error, now + STARTUP_TIMEOUT));
        startup.ready();
        startup.observe(Some(124), now + STARTUP_TIMEOUT);
        assert!(!startup.waiting(error, now + STARTUP_TIMEOUT));
        startup.observe(None, now + STARTUP_TIMEOUT);
        assert!(!startup.waiting(error, now + STARTUP_TIMEOUT));
        startup.observe(Some(124), now + STARTUP_TIMEOUT);
        assert!(startup.waiting(error, now + STARTUP_TIMEOUT));
    }
}
