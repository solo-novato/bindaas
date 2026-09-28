use bindaas::codex::{discover, Client, Sink};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
#[tokio::main]
async fn main() -> Result<(), String> {
    let project = tempfile::tempdir().map_err(|e| e.to_string())?;
    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
    let e = events.clone();
    let sink: Sink = Arc::new(move |name, value| {
        if name == "codex://turn-completed"
            || name == "codex://timeline-item"
            || name == "codex://turn-diff"
            || name == "codex://approval-requested"
        {
            e.lock().unwrap().push((name.into(), value));
        }
    });
    let c = Client::spawn(&discover(None)?, 1, sink, Arc::new(Notify::new())).await?;
    let result=async{
        let thread=c.request("thread/start",json!({"cwd":project.path(),"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"})).await?;
        let id=thread["thread"]["id"].as_str().ok_or("No thread id")?;
        c.request("turn/start",json!({"threadId":id,"input":[{"type":"text","text":"This is an integration smoke test in an empty temporary directory. Create smoke.txt containing exactly WORKBENCH_OK followed by a newline. Run wc -c smoke.txt to verify its length. Do not do anything else. Finish with a short confirmation.","text_elements":[]}]})).await?;
        tokio::time::timeout(Duration::from_secs(120),async{loop{
            let snapshot=events.lock().unwrap().clone();
            if snapshot.iter().any(|(n,_)|n=="codex://approval-requested"){return Err("Smoke test requires an interactive approval; run it in the app".to_string());}
            if let Some((_,v))=snapshot.iter().find(|(n,_)|n=="codex://turn-completed"){
                if v["turn"]["status"]!="completed"{return Err(format!("Real turn ended with {}",v["turn"]["status"]));}
                let disk=std::fs::read_to_string(project.path().join("smoke.txt")).map_err(|e|e.to_string())?;
                if disk!="WORKBENCH_OK\n"{return Err("Real Codex file content did not match".into());}
                if !snapshot.iter().any(|(_,v)|v["kind"]=="command"&&v["exitCode"]==0){return Err("No successful command was observed".into());}
                println!("Real task completed; exact file content and successful command verified.");
                println!("File-change event: {}. Live diff event: {}.",snapshot.iter().any(|(_,v)|v["kind"]=="fileChange"),snapshot.iter().any(|(n,_)|n=="codex://turn-diff"));return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }}).await.map_err(|_|"Real task smoke timed out".to_string())?
    }.await;
    c.stop().await;
    result
}
