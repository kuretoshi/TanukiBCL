use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub fn jobs(speech: &Value, session: &str, player: u64, refs: &Value, now: u64) -> Vec<Value> {
    let Some(refs) = refs.as_array().filter(|r| (1..=2).contains(&r.len())) else { return vec![]; };
    if speech["session"] != session { return vec![]; }
    let selected:Vec<_> = speech["players"].as_array().into_iter().flatten().filter(|j|j["playerId"]==player && matches!(j["kind"].as_str(),Some("hero"|"ng")) && j["request"].as_u64().is_some_and(|r|r>0) && j["expires"].as_u64().unwrap_or(0)>now && refs.iter().any(|r|r["kind"]==j["kind"] && r["request"]==j["request"])).cloned().collect();
    if selected.len()==refs.len(){selected}else{vec![]}
}
fn identity(j:&Value)->String {json!([j["playerId"],j["kind"],j["request"],j["words"]]).to_string()}
pub fn current(old:&Value, speech:&Value, now:u64)->bool {
    speech["players"].as_array().is_some_and(|ps|ps.iter().any(|p|identity(p)==identity(old) && p["expires"].as_u64().unwrap_or(0)>now))
}
#[derive(Default)]
pub struct Requests {
    session:String,
    pending:HashMap<u64,u64>,
    last:HashMap<u64,u64>,
    handled:HashSet<String>,
}
impl Requests {
    pub fn reset(&mut self,session:&str){if self.session!=session {*self=Self{session:session.into(),..Self::default()};}}
    pub fn begin(&mut self,session:&str,player:u64,at:u64,now:u64)->bool {
        self.reset(session);
        if player>255 || at>now+100 || now.saturating_sub(at)>5000 || self.pending.len()>=4 || self.pending.contains_key(&player) || self.last.get(&player).is_some_and(|t|*t>=at) || self.handled.len()>=1024 {return false;}
        self.pending.insert(player,at);self.last.insert(player,at);true
    }
    pub fn end(&mut self,session:&str,player:u64,at:u64)->bool {
        if self.session!=session || self.pending.get(&player)!=Some(&at){return false;}
        self.pending.remove(&player);true
    }
    pub fn accept(&mut self,j:&Value)->bool {self.handled.insert(identity(j))}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renewing_ng_deadline_keeps_job_but_reassignment_does_not(){
        let j=json!({"playerId":1,"kind":"ng","request":2,"words":["タスク"],"expires":2400});
        let mut live=json!({"session":"s","players":[j.clone()]});
        let refs=json!([{"kind":"ng","request":2}]);
        assert_eq!(jobs(&live,"s",1,&refs,2000).len(),1);
        live["players"][0]["expires"]=json!(4400);
        assert!(current(&j,&live,3000));
        live["players"][0]["words"]=json!(["会議"]);
        assert!(!current(&j,&live,3000));
        assert!(jobs(&live,"other",1,&refs,3000).is_empty());
        assert!(jobs(&live,"s",2,&refs,3000).is_empty());
    }
    #[test]
    fn duplicates_stale_audio_and_cross_session_results_are_rejected(){
        let mut r=Requests::default();
        assert!(!r.begin("s",1,1000,7000));assert!(r.begin("s",1,7000,7000));
        assert!(!r.begin("s",1,7001,7001));assert!(r.end("s",1,7000));
        assert!(!r.begin("s",1,7000,7001));assert!(r.begin("s",1,7002,7002));
        r.reset("t");assert!(!r.end("s",1,7002));
        let j=json!({"playerId":1,"kind":"hero","request":1,"words":["変身"]});
        assert!(r.accept(&j));assert!(!r.accept(&j));
    }
}
