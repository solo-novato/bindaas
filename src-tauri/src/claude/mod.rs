pub mod history;
pub mod normalize;
use crate::codex::{
    normalize::{prefix, TEXT_CAP},
    Sink,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{oneshot, Mutex, Notify},
};
use tokio_util::codec::{FramedRead, LinesCodec};

static SEQUENCE: AtomicU64 = AtomicU64::new(1);
pub fn uuid() -> String {
    let hash = format!(
        "{:x}",
        Sha256::digest(format!(
            "{:?}-{}-{}",
            std::time::SystemTime::now(),
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ))
    );
    format!(
        "{}-{}-4{}-8{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    )
}
pub fn discover(override_path: Option<&str>) -> Result<PathBuf, String> {
    let candidates = if let Some(p) = override_path {
        vec![PathBuf::from(p)]
    } else {
        // The user's shell PATH plus common install locations (see shell_env).
        crate::shell_env::find("claude").into_iter().collect()
    };
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        "Claude Code was not found. Install the official CLI or choose its executable.".into()
    })
}
pub async fn probe(executable: &Path) -> Result<Value, String> {
    async fn output(executable: &Path, args: &[&str]) -> Result<std::process::Output, String> {
        tokio::time::timeout(
            Duration::from_secs(15),
            {
                let mut command = Command::new(executable);
                crate::shell_env::apply(&mut command);
                command
            }
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
        )
        .await
        .map_err(|_| "Claude connection check timed out")?
        .map_err(|e| e.to_string())
    }
    let version = output(executable, &["--version"]).await?;
    let version = String::from_utf8_lossy(&version.stdout).trim().to_string();
    let numbers: Vec<u32> = version
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    if numbers.as_slice() < [2, 1, 274].as_slice() {
        return Err("Update Claude Code to 2.1.274 or later to connect.".into());
    }
    let auth = output(executable, &["auth", "status", "--json"]).await?;
    let value: Value = serde_json::from_slice(&auth.stdout)
        .map_err(|_| "Claude did not return a valid authentication status")?;
    let logged_in = value["loggedIn"].as_bool().unwrap_or(false);
    // Deliberately project only non-secret, non-identifying auth metadata.
    Ok(
        json!({"version":version,"authenticated":logged_in,"authMethod":value["authMethod"].as_str(),"state":if logged_in {"ready"}else{"authRequired"}}),
    )
}

pub struct Runtime {
    pub settings: Value,
    pub title: String,
    pub turn: Option<Value>,
    pub turns: Vec<Value>,
    pub approvals: HashMap<String, Value>,
    pub items: Vec<Value>,
    pub usage: Value,
    pub background: HashMap<String, Value>,
    normalizer: normalize::Normalizer,
    stream_message: String,
    stream_text: HashMap<usize, String>,
    interrupted: bool,
    last_stream_emit: Instant,
    code_permission: Option<String>,
    pending_result: Option<Value>,
    pub touched: Instant,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            settings: normalize::settings(None, None),
            title: "Claude conversation".into(),
            turn: None,
            turns: vec![],
            approvals: HashMap::new(),
            items: vec![],
            usage: Value::Null,
            background: HashMap::new(),
            normalizer: Default::default(),
            stream_message: String::new(),
            stream_text: HashMap::new(),
            interrupted: false,
            last_stream_emit: Instant::now() - Duration::from_secs(1),
            code_permission: None,
            pending_result: None,
            touched: Instant::now(),
        }
    }
}
pub struct Client {
    pub id: String,
    pub root: PathBuf,
    pub generation: u64,
    pub alive: AtomicBool,
    closing: AtomicBool,
    pub idle_timeout: AtomicU64,
    pub runtime: Mutex<Runtime>,
    pub initialization: Mutex<Value>,
    input: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    sink: Sink,
    stop: Notify,
    closed: Notify,
    wake: Notify,
}
impl Client {
    pub fn thread(&self) -> String {
        format!("claude:{}", self.id)
    }
    pub fn emit(&self, name: &str, mut payload: Value) {
        if let Some(o) = payload.as_object_mut() {
            o.insert("harness".into(), json!("claude"));
            o.insert("generation".into(), json!(self.generation));
            o.entry("threadId").or_insert_with(|| json!(self.thread()));
        }
        (self.sink)(&format!("agent://{name}"), payload);
    }
    pub async fn spawn(
        executable: &Path,
        root: &Path,
        id: &str,
        resume: bool,
        generation: u64,
        sink: Sink,
        idle_seconds: u64,
    ) -> Result<Arc<Self>, String> {
        if !history::valid_id(id) {
            return Err("Invalid Claude session ID".into());
        }
        let mut command = Command::new(executable);
        crate::shell_env::apply(&mut command);
        command
            .args([
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--replay-user-messages",
                "--permission-prompt-tool",
                "stdio",
            ])
            .arg(format!(
                "{}={id}",
                if resume { "--resume" } else { "--session-id" }
            ))
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start Claude: {e}"))?;
        let stdout = child.stdout.take().ok_or("Missing Claude output")?;
        let mut stderr = child.stderr.take().ok_or("Missing Claude diagnostics")?;
        let c = Arc::new(Self {
            id: id.into(),
            root: root.into(),
            generation,
            alive: AtomicBool::new(true),
            closing: AtomicBool::new(false),
            idle_timeout: AtomicU64::new(idle_seconds.max(5)),
            runtime: Mutex::new(Runtime::default()),
            initialization: Mutex::new(Value::Null),
            input: Mutex::new(child.stdin.take()),
            pending: Mutex::new(HashMap::new()),
            sink,
            stop: Notify::new(),
            closed: Notify::new(),
            wake: Notify::new(),
        });
        let read = c.clone();
        let output_task = tokio::spawn(async move {
            let mut lines =
                FramedRead::new(stdout, LinesCodec::new_with_max_length(16 * 1024 * 1024));
            while let Some(line) = lines.next().await {
                match line {
                    Ok(line) => {
                        match serde_json::from_str::<Value>(&line) {
                            Ok(v) => read.handle(v).await,
                            Err(_) => {
                                read.emit("warning",json!({"message":"Claude emitted an unreadable protocol message."}));
                            }
                        }
                    }
                    Err(_) => {
                        read.emit(
                            "warning",
                            json!({"message":"Claude output exceeded the protocol limit."}),
                        );
                        read.stop.notify_one();
                        break;
                    }
                }
            }
        });
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            while stderr.read(&mut buf).await.unwrap_or(0) > 0 {}
        });
        let wait = c.clone();
        let pid = child.id();
        tokio::spawn(async move {
            tokio::select! {_=wait.stop.notified()=>{
                #[cfg(unix)] if let Some(pid)=pid {unsafe {libc::kill(-(pid as i32),libc::SIGTERM);}}
                let _=child.kill().await;
            },_=child.wait()=>{}}
            #[cfg(unix)]
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), output_task).await;
            wait.alive.store(false, Ordering::SeqCst);
            wait.wake.notify_one();
            wait.input.lock().await.take();
            for (_, tx) in wait.pending.lock().await.drain() {
                let _ = tx.send(Err("Claude disconnected before replying".into()));
            }
            let mut runtime = wait.runtime.lock().await;
            let working = runtime
                .turn
                .as_ref()
                .is_some_and(|t| t["status"] == "inProgress");
            let interrupted = runtime.interrupted;
            if working {
                if let Some(t) = runtime.turn.as_mut() {
                    t["status"] = json!(if interrupted {
                        "interrupted"
                    } else {
                        "connectionLost"
                    })
                }
            }
            runtime.approvals.clear();
            runtime.background.clear();
            if working && interrupted {
                if let Some(t) = &runtime.turn {
                    wait.emit("turn-completed", json!({"turn":t}));
                }
            }
            drop(runtime);
            wait.emit(
                "connection",
                json!({"type":if working && !interrupted {"disconnected"}else{"sleeping"}}),
            );
            wait.closed.notify_waiters();
        });
        let idle = c.clone();
        tokio::spawn(async move {
            loop {
                let wake = idle.wake.notified();
                if !idle.alive.load(Ordering::SeqCst) {
                    break;
                }
                let r = idle.runtime.lock().await;
                let eligible = r.turn.as_ref().is_none_or(|t| t["status"] != "inProgress")
                    && r.approvals.is_empty()
                    && r.background.is_empty();
                let remaining = Duration::from_secs(idle.idle_timeout.load(Ordering::SeqCst))
                    .saturating_sub(r.touched.elapsed());
                drop(r);
                if !eligible || !idle.pending.lock().await.is_empty() {
                    wake.await;
                    continue;
                }
                tokio::select! {_=wake=>{},_=tokio::time::sleep(remaining)=>{
                    let r=idle.runtime.lock().await;
                    if r.turn.as_ref().is_none_or(|t|t["status"]!="inProgress") && r.approvals.is_empty() && r.background.is_empty() && idle.pending.lock().await.is_empty() && r.touched.elapsed()>=Duration::from_secs(idle.idle_timeout.load(Ordering::SeqCst)) {
                        idle.closing.store(true,Ordering::SeqCst);idle.stop.notify_one();break;
                    }
                }}
            }
        });
        let result = c
            .control(json!({"subtype":"initialize","hooks":null}))
            .await;
        match result {
            Ok(v) => {
                if !v.is_object() {
                    c.stop.notify_one();
                    return Err("Claude did not return the required initialization response. Update the CLI and reconnect.".into());
                }
                {
                    let mut r = c.runtime.lock().await;
                    if let Some(p) = v["permissionMode"].as_str() {
                        r.settings = normalize::settings(v["model"].as_str(), Some(p));
                        if p != "plan" {
                            r.code_permission = Some(p.into());
                        }
                    }
                }
                *c.initialization.lock().await = v;
                c.emit("connection", json!({"type":"ready"}));
                Ok(c)
            }
            Err(e) => {
                c.stop.notify_one();
                Err(e)
            }
        }
    }
    async fn write(&self, v: Value) -> Result<(), String> {
        if !self.alive.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
            return Err("Claude is disconnected".into());
        }
        let mut input = self.input.lock().await;
        let input = input.as_mut().ok_or("Claude is disconnected")?;
        let mut bytes = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        input.write_all(&bytes).await.map_err(|e| e.to_string())?;
        input.flush().await.map_err(|e| e.to_string())
    }
    pub async fn control(&self, request: Value) -> Result<Value, String> {
        let id = uuid();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        if let Err(e) = self
            .write(json!({"type":"control_request","request_id":id,"request":request}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        let result = tokio::time::timeout(Duration::from_secs(60), rx).await;
        self.pending.lock().await.remove(&id);
        self.runtime.lock().await.touched = Instant::now();
        self.wake.notify_one();
        match result {
            Ok(Ok(v)) => v,
            _ => Err("Claude did not confirm the request. Reconnect before retrying.".into()),
        }
    }
    async fn publish_item(&self, r: &mut Runtime, item: Value) {
        if let Some(i) = r.items.iter().position(|v| v["id"] == item["id"]) {
            r.items[i] = item.clone()
        } else {
            r.items.push(item.clone());
            if r.items.len() > 400 {
                r.items.remove(0);
            }
        }
        self.emit("timeline-item", item);
    }
    async fn handle(&self, mut v: Value) {
        if v["type"] == "control_response" {
            let response = &v["response"];
            if let Some(id) = response["request_id"].as_str() {
                if let Some(tx) = self.pending.lock().await.remove(id) {
                    let _ = tx.send(if response["subtype"] == "error" {
                        Err(response["error"]
                            .as_str()
                            .unwrap_or("Claude rejected the request")
                            .into())
                    } else {
                        Ok(response["response"].clone())
                    });
                }
            }
            return;
        }
        let mut r = self.runtime.lock().await;
        r.touched = Instant::now();
        self.wake.notify_one();
        let turn = r
            .turn
            .as_ref()
            .and_then(|t| t["id"].as_str())
            .unwrap_or("recorded")
            .to_string();
        if v["type"] == "control_request" {
            let req = &v["request"];
            let id = v["request_id"].as_str().unwrap_or("");
            if id.is_empty() {
                return;
            }
            if req["subtype"] != "can_use_tool" {
                drop(r);
                let _=self.write(json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported Bindaas interaction"}})).await;
                return;
            }
            let name = req["tool_name"].as_str().unwrap_or("Tool");
            let input = &req["input"];
            let questions:Vec<_>=input["questions"].as_array().into_iter().flatten().enumerate().map(|(i,q)|json!({"id":i.to_string(),"question":q["question"],"header":q["header"],"options":q["options"],"multiSelect":q["multiSelect"]==true})).collect();
            let item = json!({"requestId":format!("claude:{}:{id}",self.id),"nativeRequestId":id,"generation":self.generation,"harness":"claude","threadId":self.thread(),"turnId":turn,"itemId":req["tool_use_id"],"kind":if name=="AskUserQuestion" {"userInput"} else {"commandExecution"},"reason":if name=="ExitPlanMode" {"Claude is ready to leave Plan mode. Review the proposed plan before allowing implementation.".to_string()}else{format!("Claude requests permission to use {name}")},"command":input["command"],"cwd":self.root,"permissions":if name=="AskUserQuestion" {Value::Null}else{json!({"tool":name,"input":input})},"questions":questions,"decisions":["accept","decline","cancel"],"nativeInput":input,"nativeTool":name});
            r.approvals.insert(id.into(), item.clone());
            let mut public = item;
            public.as_object_mut().unwrap().remove("nativeInput");
            public.as_object_mut().unwrap().remove("nativeRequestId");
            self.emit("approval-requested", public);
            return;
        }
        if v["type"] == "control_cancel_request" {
            if let Some(id) = v["request_id"].as_str() {
                r.approvals.remove(id);
                self.emit("approval-resolved",json!({"requestId":format!("claude:{}:{id}",self.id),"waiting":!r.approvals.is_empty()}));
            }
            return;
        }
        if v["type"] == "system" && v["subtype"] == "task_started" {
            if let Some(id) = v["task_id"].as_str() {
                let item = json!({"id":format!("background:{id}"),"threadId":self.thread(),"turnId":turn,"kind":"tool","title":v["description"].as_str().unwrap_or("Claude background task"),"status":"inProgress"});
                r.background.insert(id.into(), item.clone());
                self.publish_item(&mut r, item).await;
            }
            return;
        }
        if v["type"] == "system" && v["subtype"] == "task_notification" {
            if let Some(id) = v["task_id"].as_str() {
                if let Some(mut item) = r.background.remove(id) {
                    item["status"] = json!(if v["status"] == "failed" {
                        "failed"
                    } else if v["status"] == "stopped" {
                        "interrupted"
                    } else {
                        "completed"
                    });
                    item["output"] = json!(prefix(v["summary"].as_str().unwrap_or(""), 20 * 1024));
                    self.publish_item(&mut r, item).await;
                }
            }
            if r.background.is_empty() {
                if let Some(result) = r.pending_result.take() {
                    v = result;
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        if v["type"] == "result" && !r.background.is_empty() {
            r.pending_result = Some(v);
            return;
        }
        match v["type"].as_str().unwrap_or("") {
            "system" => {
                if v["subtype"] == "init" {
                    if v["session_id"].as_str() != Some(&self.id) {
                        self.emit("warning",json!({"message":"Claude returned a different session. Stopping to protect conversation routing."}));
                        self.stop.notify_one();
                        return;
                    }
                    r.settings["model"] = v["model"].clone();
                    if let Some(p) = v["permissionMode"].as_str() {
                        if p != "plan" {
                            r.code_permission = Some(p.into());
                        }
                        r.settings["approvalPolicy"] = json!(p);
                        r.settings["mode"] = json!(if p == "plan" { "plan" } else { "default" });
                    }
                    self.emit("thread-settings", json!({"settings":r.settings}));
                } else if v["subtype"] == "task_started" {
                    if let Some(id) = v["task_id"].as_str() {
                        r.background.insert(id.into(), v.clone());
                    }
                } else if v["subtype"] == "task_notification" {
                    if let Some(id) = v["task_id"].as_str() {
                        r.background.remove(id);
                    }
                } else if v["subtype"] == "api_retry" {
                    self.emit("warning",json!({"message":format!("Claude is retrying a provider request (attempt {}).",v["attempt"])}));
                }
            }
            "assistant" | "user" => {
                if v["type"] == "assistant" && !v["message"]["model"].is_null() {
                    r.settings["model"] = v["message"]["model"].clone();
                }
                let items = r.normalizer.message(&v, &self.thread(), &turn);
                for item in items {
                    self.publish_item(&mut r, item).await;
                }
            }
            "stream_event" => {
                let e = &v["event"];
                let index = e["index"].as_u64().unwrap_or(0) as usize;
                if e["type"] == "message_start" {
                    r.stream_message = e["message"]["id"].as_str().unwrap_or(&turn).into();
                    r.stream_text.clear();
                }
                if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                    let text = r.stream_text.entry(index).or_default();
                    if text.len() < TEXT_CAP {
                        text.push_str(e["delta"]["text"].as_str().unwrap_or(""));
                        let mut end = TEXT_CAP.min(text.len());
                        while !text.is_char_boundary(end) {
                            end -= 1
                        }
                        text.truncate(end);
                    }
                    let text = text.clone();
                    let item = json!({"id":format!("{}:{index}",r.stream_message),"threadId":self.thread(),"turnId":turn,"kind":"message","title":"Claude","text":text,"status":"inProgress"});
                    if r.last_stream_emit.elapsed() >= Duration::from_millis(40) {
                        r.last_stream_emit = Instant::now();
                        self.publish_item(&mut r, item).await;
                    } else if let Some(existing) =
                        r.items.iter_mut().find(|i| i["id"] == item["id"])
                    {
                        *existing = item;
                    }
                }
            }
            "result" => {
                if let Some(mut t) = r.turn.clone() {
                    let status = if r.interrupted {
                        "interrupted"
                    } else if v["is_error"] == true
                        || v["subtype"].as_str().is_some_and(|s| s != "success")
                    {
                        "failed"
                    } else {
                        "completed"
                    };
                    t["status"] = json!(status);
                    t["durationMs"] = v["duration_ms"].clone();
                    t["settings"] = r.settings.clone();
                    if status == "failed" {
                        t["error"] = json!(v["errors"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n"));
                    }
                    for item in &mut r.items {
                        if item["kind"] == "message" && item["status"] == "inProgress" {
                            item["status"] = json!("completed");
                            self.emit("timeline-item", item.clone());
                        }
                    }
                    if r.settings["mode"] == "plan" {
                        if let Some(text) = v["result"].as_str() {
                            let item = json!({"id":format!("plan:{turn}"),"threadId":self.thread(),"turnId":turn,"kind":"plan","title":"Proposed plan","text":prefix(text,TEXT_CAP),"status":"completed"});
                            self.publish_item(&mut r, item).await;
                        }
                    }
                    t["items"] = json!(r.items);
                    r.turn = Some(t.clone());
                    r.turns.insert(0, t.clone());
                    r.turns.truncate(30);
                    while r.turns.len() > 1
                        && r.turns.iter().map(|t| t.to_string().len()).sum::<usize>()
                            > 8 * 1024 * 1024
                    {
                        r.turns.pop();
                    }
                    let u = &v["usage"];
                    r.usage = json!({"scope":"turn","total":{"inputTokens":u["input_tokens"],"cachedInputTokens":u["cache_read_input_tokens"],"outputTokens":u["output_tokens"],"totalTokens":null},"last":{"inputTokens":null,"outputTokens":null,"cachedInputTokens":null,"totalTokens":null},"modelContextWindow":null,"estimatedCostUsd":v["total_cost_usd"]});
                    self.emit("token-usage", json!({"usage":r.usage}));
                    for (id, _) in r.approvals.drain() {
                        self.emit(
                            "approval-resolved",
                            json!({"requestId":format!("claude:{}:{id}",self.id),"waiting":false}),
                        );
                    }
                    self.emit("turn-completed", json!({"turn":t}));
                }
            }
            _ => {}
        }
    }
    pub async fn start(
        &self,
        prompt: &str,
        mut blocks: Vec<Value>,
        model: Option<&str>,
        mode: Option<&str>,
    ) -> Result<Value, String> {
        if (prompt.trim().is_empty() && blocks.is_empty()) || prompt.len() > 128 * 1024 {
            return Err("Add a message or attachment; prompt limit is 128 KiB".into());
        }
        {
            let r = self.runtime.lock().await;
            if r.turn.as_ref().is_some_and(|t| t["status"] == "inProgress")
                || !r.approvals.is_empty()
            {
                return Err("This conversation is already working. Queue a follow-up.".into());
            }
        }
        self.update(model, mode).await?;
        let id = uuid();
        let mut r = self.runtime.lock().await;
        if !self.alive.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
            return Err("Claude is sleeping. Retry to resume this conversation.".into());
        }
        r.title = prefix(prompt, 120);
        r.items.clear();
        r.normalizer = Default::default();
        r.interrupted = false;
        r.pending_result = None;
        r.touched = Instant::now();
        let turn = json!({"id":id,"status":"inProgress","startedAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),"settings":r.settings});
        r.turn = Some(turn.clone());
        let settings = r.settings.clone();
        drop(r);
        self.emit("turn-started", json!({"turn":turn,"settings":settings}));
        if !prompt.trim().is_empty() {
            blocks.insert(0, json!({"type":"text","text":prompt}));
        }
        if let Err(e)=self.write(json!({"type":"user","uuid":id,"session_id":self.id,"parent_tool_use_id":null,"message":{"role":"user","content":blocks}})).await{
            if let Some(t)=self.runtime.lock().await.turn.as_mut(){t["status"]=json!("connectionLost")};self.emit("connection",json!({"type":"disconnected","message":"Claude could not receive the message"}));return Err(e)
        }
        Ok(json!({"threadId":self.thread(),"turn":turn,"settings":settings}))
    }
    pub async fn update(&self, model: Option<&str>, mode: Option<&str>) -> Result<Value, String> {
        if let Some(m) = model {
            self.control(json!({"subtype":"set_model","model":m}))
                .await?;
            self.runtime.lock().await.settings["model"] = json!(m);
        }
        if let Some(mode) = mode {
            let r = self.runtime.lock().await;
            let changed = r.settings["mode"] != mode;
            let permission = if mode == "plan" {
                "plan".to_string()
            } else {
                r.code_permission
                    .clone()
                    .unwrap_or_else(|| "default".into())
            };
            drop(r);
            if changed {
                self.control(json!({"subtype":"set_permission_mode","mode":permission}))
                    .await?;
                let mut r = self.runtime.lock().await;
                r.settings["mode"] = json!(mode);
                r.settings["approvalPolicy"] = json!(permission);
            }
        }
        let settings = self.runtime.lock().await.settings.clone();
        self.emit("thread-settings", json!({"settings":settings}));
        Ok(settings)
    }
    pub async fn interrupt(&self, turn: &str) -> Result<Value, String> {
        {
            let mut r = self.runtime.lock().await;
            if r.turn
                .as_ref()
                .is_none_or(|t| t["id"] != turn || t["status"] != "inProgress")
            {
                return Err("This turn is no longer active".into());
            }
            r.interrupted = true;
        }
        let result = self.control(json!({"subtype":"interrupt"})).await;
        if result.is_err() {
            self.runtime.lock().await.interrupted = false;
            return result;
        }
        if !self.runtime.lock().await.background.is_empty() {
            self.shutdown(true).await?;
        }
        result
    }
    pub async fn respond(
        &self,
        generation: u64,
        id: &str,
        decision: &Value,
        answers: Option<Value>,
    ) -> Result<(), String> {
        if generation != self.generation || !self.alive.load(Ordering::SeqCst) {
            return Err("This Claude request is no longer active".into());
        }
        let id = id
            .strip_prefix(&format!("claude:{}:", self.id))
            .ok_or("Request belongs to another conversation")?;
        let mut r = self.runtime.lock().await;
        let request = r
            .approvals
            .get(id)
            .cloned()
            .ok_or("Request has already been resolved")?;
        let mut input = request["nativeInput"].clone();
        let allow = if request["kind"] == "userInput" {
            let answers = answers.ok_or("Answer every question")?;
            let mut native = serde_json::Map::new();
            for q in request["questions"].as_array().ok_or("Invalid questions")? {
                let answer = &answers[q["id"].as_str().unwrap_or("")];
                if !answer
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 16000)
                    && !answer.as_array().is_some_and(|a| {
                        !a.is_empty()
                            && a.iter()
                                .all(|v| v.as_str().is_some_and(|s| s.len() <= 16000))
                    })
                {
                    return Err("Answer every question before submitting".into());
                }
                let answer = if let Some(a) = answer.as_array() {
                    json!(a
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", "))
                } else {
                    answer.clone()
                };
                native.insert(q["question"].as_str().unwrap_or("").into(), answer);
            }
            input["answers"] = Value::Object(native);
            true
        } else {
            if !["accept", "decline", "cancel"]
                .iter()
                .any(|d| decision == *d)
            {
                return Err("Invalid Claude permission decision".into());
            }
            decision == "accept"
        };
        let response = if allow {
            json!({"behavior":"allow","updatedInput":input})
        } else {
            json!({"behavior":"deny","message":"The user declined this action.","interrupt":decision=="cancel"})
        };
        // Hold the registry lock through write: duplicate clicks cannot resolve twice.
        self.write(json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}})).await?;
        r.approvals.remove(id);
        if request["nativeTool"] == "ExitPlanMode" && allow {
            r.settings["mode"] = json!("default");
            r.settings["approvalPolicy"] = json!(r.code_permission.as_deref().unwrap_or("default"));
            self.emit("thread-settings", json!({"settings":r.settings}));
        }
        self.emit(
            "approval-resolved",
            json!({"requestId":request["requestId"],"waiting":!r.approvals.is_empty()}),
        );
        Ok(())
    }
    pub fn set_idle_timeout(&self, seconds: u64) {
        self.idle_timeout.store(seconds.max(5), Ordering::SeqCst);
        self.wake.notify_one();
    }
    pub async fn shutdown(&self, force: bool) -> Result<(), String> {
        let r = self.runtime.lock().await;
        if !force
            && (r.turn.as_ref().is_some_and(|t| t["status"] == "inProgress")
                || !r.approvals.is_empty()
                || !r.background.is_empty())
        {
            return Err("Finish or stop Claude tasks before disconnecting".into());
        }
        self.closing.store(true, Ordering::SeqCst);
        drop(r);
        let closed = self.closed.notified();
        if self.alive.load(Ordering::SeqCst) {
            self.stop.notify_one();
            tokio::time::timeout(Duration::from_secs(5), closed)
                .await
                .map_err(|_| "Claude did not stop in time")?;
        }
        Ok(())
    }
}

pub struct Manager {
    pub clients: HashMap<String, Arc<Client>>,
    pub sink: Sink,
    pub next: u64,
    pub catalog: Option<Value>,
}
impl Manager {
    pub fn new(sink: Sink) -> Self {
        Self {
            clients: HashMap::new(),
            sink,
            next: 0,
            catalog: None,
        }
    }
    pub async fn get(
        &mut self,
        root: &Path,
        id: Option<&str>,
        executable: &Path,
        idle: u64,
    ) -> Result<Arc<Client>, String> {
        let native = id
            .map(|s| s.strip_prefix("claude:").unwrap_or(s).to_string())
            .unwrap_or_else(uuid);
        if let Some(c) = self.clients.get(&native) {
            if c.root != root {
                return Err("Conversation belongs to another project".into());
            }
            if c.alive.load(Ordering::SeqCst) && !c.closing.load(Ordering::SeqCst) {
                return Ok(c.clone());
            }
            if c.alive.load(Ordering::SeqCst) {
                c.shutdown(true).await?;
            }
        }
        if id.is_some() {
            history::locate(&history::config_dir(), root, &native)?;
        }
        self.next += 1;
        let c = Client::spawn(
            executable,
            root,
            &native,
            id.is_some(),
            self.next,
            self.sink.clone(),
            idle,
        )
        .await?;
        self.clients.insert(native, c.clone());
        Ok(c)
    }
    pub fn existing(&self, id: &str) -> Option<Arc<Client>> {
        self.clients
            .get(id.strip_prefix("claude:").unwrap_or(id))
            .cloned()
    }
    pub async fn shutdown(&self, force: bool) -> Result<(), String> {
        if !force {
            for c in self.clients.values() {
                let r = c.runtime.lock().await;
                if c.alive.load(Ordering::SeqCst)
                    && (r.turn.as_ref().is_some_and(|t| t["status"] == "inProgress")
                        || !r.approvals.is_empty()
                        || !r.background.is_empty())
                {
                    return Err("Finish or stop Claude tasks before disconnecting".into());
                }
            }
        }
        for c in self.clients.values() {
            c.shutdown(force).await?;
        }
        Ok(())
    }
}
