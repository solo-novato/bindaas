pub mod conversations;
pub mod input;
pub mod normalize;
pub mod runs;
pub mod session;
pub mod speed;
pub mod thread_settings;
use futures_util::StreamExt;
use normalize::{prefix, tail, Approval, DIFF_CAP, OUTPUT_CAP};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::{oneshot, Mutex, Notify},
    time::Instant,
};
use tokio_util::codec::{FramedRead, LinesCodec};
pub type Sink = Arc<dyn Fn(&str, Value) + Send + Sync>;
type Reply = oneshot::Sender<Result<Value, String>>;
pub struct Client {
    pub generation: u64,
    pub pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Reply>>,
    pub approvals: Mutex<HashMap<String, Approval>>,
    next: AtomicU64,
    pub alive: AtomicBool,
    pub active: Mutex<HashMap<String, String>>,
    pub login: AtomicBool,
    pub resumed: Mutex<HashMap<String, Value>>,
    pub settings: Mutex<HashMap<String, Value>>,
    pub usage: Mutex<HashMap<String, Value>>,
    pub thinking: Mutex<HashMap<String, (String, String)>>,
    settings_changed: Mutex<HashMap<String, Arc<Notify>>>,
    pub output: Mutex<HashMap<String, String>>,
    touched: Mutex<Instant>,
    pub wake: Arc<Notify>,
    sink: Sink,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    exited: AtomicBool,
    exit_notify: Notify,
}
impl Client {
    pub async fn spawn(
        executable: &Path,
        generation: u64,
        sink: Sink,
        wake: Arc<Notify>,
    ) -> Result<Arc<Self>, String> {
        let mut command = Command::new(executable);
        crate::shell_env::apply(&mut command);
        command
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start Codex: {e}"))?;
        let stdout = child.stdout.take().ok_or("No Codex stdout")?;
        let mut stderr = child.stderr.take().ok_or("No Codex stderr")?;
        let stdin = child.stdin.take();
        let pid = child.id().unwrap_or(0);
        let (tx, rx) = oneshot::channel();
        let client = Arc::new(Self {
            generation,
            pid,
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            active: Mutex::new(HashMap::new()),
            login: AtomicBool::new(false),
            resumed: Mutex::new(HashMap::new()),
            settings: Mutex::new(HashMap::new()),
            usage: Mutex::new(HashMap::new()),
            thinking: Mutex::new(HashMap::new()),
            settings_changed: Mutex::new(HashMap::new()),
            output: Mutex::new(HashMap::new()),
            touched: Mutex::new(Instant::now()),
            wake,
            sink,
            shutdown: Mutex::new(Some(tx)),
            exited: AtomicBool::new(false),
            exit_notify: Notify::new(),
        });
        let c = client.clone();
        tokio::spawn(async move {
            let mut lines =
                FramedRead::new(stdout, LinesCodec::new_with_max_length(16 * 1024 * 1024));
            let mut bad = 0;
            let mut deltas: HashMap<String, Value> = HashMap::new();
            let mut flush_at = Instant::now() + Duration::from_millis(40);
            loop {
                tokio::select! {
                    line=lines.next()=>{match line {
                        Some(Ok(line))=>{if !c.alive.load(Ordering::SeqCst){break;}match serde_json::from_str::<Value>(&line){Ok(v)=>{bad=0;
                            let method=v["method"].as_str().unwrap_or("");
                            if method=="item/agentMessage/delta"||method=="item/plan/delta"||method=="item/commandExecution/outputDelta"||method=="item/reasoning/summaryTextDelta" {
                                let p=&v["params"];let key=format!("{}:{}:{}:{}",p["threadId"],p["turnId"],p["itemId"],p["summaryIndex"]);let first=deltas.is_empty();
                                let delta=deltas.entry(key).or_insert_with(||json!({"threadId":p["threadId"],"turnId":p["turnId"],"itemId":p["itemId"],"summaryIndex":p["summaryIndex"],"kind":if method.contains("outputDelta"){"output"}else if method.contains("summaryTextDelta"){"thinking"}else if method=="item/plan/delta"{"plan"}else{"text"},"delta":"","truncated":false}));
                                let joined=format!("{}{}",delta["delta"].as_str().unwrap_or(""),p["delta"].as_str().unwrap_or(""));delta["truncated"]=json!(delta["truncated"]==true||joined.len()>normalize::PREVIEW_CAP);delta["delta"]=json!(tail(&joined,normalize::PREVIEW_CAP));
                                if method.contains("outputDelta"){c.retain_output(&format!("{}:{}:{}",p["threadId"].as_str().unwrap_or(""),p["turnId"].as_str().unwrap_or(""),p["itemId"].as_str().unwrap_or("")),p["delta"].as_str().unwrap_or(""),false).await;}
                                if first {flush_at=Instant::now()+Duration::from_millis(40);}c.touch().await;
                            }else{c.flush(&mut deltas);c.route(v).await;}
                        },Err(_)=>{bad+=1;if bad>=5{break;}}}},Some(Err(_))=>break,None=>break,
                    }},
                    _=tokio::time::sleep_until(flush_at),if !deltas.is_empty()=>{c.flush(&mut deltas);}
                }
            }
            c.flush(&mut deltas);
            c.disconnect("Codex disconnected. Restart to reconcile the thread.")
                .await;
        });
        // Drain diagnostic bytes without treating logs as protocol or exposing tokens.
        tokio::spawn(async move {
            let mut b = [0; 8192];
            while let Ok(n) = stderr.read(&mut b).await {
                if n == 0 {
                    break;
                }
            }
        });
        let c = client.clone();
        tokio::spawn(async move {
            tokio::select! {_=rx=>{
                #[cfg(unix)]unsafe{libc::kill(-(pid as i32),libc::SIGTERM);}
                let _=child.kill().await;
            },_=child.wait()=>{}}
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child.wait().await;
            c.exited.store(true, Ordering::SeqCst);
            c.exit_notify.notify_waiters();
            c.disconnect("Codex process exited").await;
        });
        client.emit("connection", json!({"type":"initializing"}));
        let init=client.request("initialize",json!({"clientInfo":{"name":"bindaas","title":"Bindaas","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await;
        let init = match init {
            Ok(v) => v,
            Err(e) => {
                client.stop().await;
                return Err(e);
            }
        };
        // Bindaas relies on newer app-server methods; refuse clearly instead of failing later.
        let version = init["userAgent"].as_str().and_then(codex_version);
        if let Some(found) = version {
            if found < MIN_CODEX_VERSION {
                client.stop().await;
                return Err(format!(
                    "Codex {} is too old for Bindaas. Update to {} or later (npm install -g @openai/codex@latest, or brew upgrade codex), then reconnect.",
                    version_text(found),
                    version_text(MIN_CODEX_VERSION)
                ));
            }
        }
        client
            .write(json!({"method":"initialized","params":{}}))
            .await?;
        client.emit(
            "connection",
            json!({"type":"ready","version": version.map(version_text)}),
        );
        Ok(client)
    }
    fn flush(&self, deltas: &mut HashMap<String, Value>) {
        if !deltas.is_empty() {
            self.emit(
                "timeline-update",
                json!(deltas
                    .drain()
                    .map(|(_, mut v)| {
                        v["generation"] = json!(self.generation);
                        v
                    })
                    .collect::<Vec<_>>()),
            );
        }
    }
    pub fn emit(&self, name: &str, mut payload: Value) {
        if name != "connection" && !self.alive.load(Ordering::SeqCst) {
            return;
        }
        if let Some(o) = payload.as_object_mut() {
            o.insert("generation".into(), json!(self.generation));
        }
        (self.sink)(&format!("codex://{name}"), payload);
    }
    pub async fn touch(&self) {
        *self.touched.lock().await = Instant::now();
        self.wake.notify_one();
    }
    async fn write(&self, value: Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or("Codex is disconnected")?;
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        stdin.write_all(&bytes).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("Codex is disconnected".into());
        }
        self.touch().await;
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(e) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        let response = tokio::time::timeout(
            Duration::from_secs(if method.starts_with("thread/") {
                90
            } else {
                45
            }),
            rx,
        )
        .await;
        self.pending.lock().await.remove(&id);
        self.touch().await;
        match response {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => Err("Codex disconnected before replying".into()),
            Err(_) => Err(format!(
                "Codex {method} timed out; restart to reconcile before retrying"
            )),
        }
    }
    async fn retain_output(&self, id: &str, text: &str, replace: bool) {
        let mut out = self.output.lock().await;
        if !out.contains_key(id) && out.len() >= 16 {
            if let Some(k) = out.keys().next().cloned() {
                out.remove(&k);
            }
        }
        let entry = out.entry(id.into()).or_default();
        *entry = tail(
            &if replace {
                text.into()
            } else {
                format!("{entry}{text}")
            },
            OUTPUT_CAP,
        );
    }
    async fn route(&self, v: Value) {
        self.touch().await;
        if let Some(method) = v["method"].as_str() {
            let p = &v["params"];
            if !v["id"].is_null() {
                if let Some(approval) = Approval::new(v["id"].clone(), method, p.clone()) {
                    let event = approval.event(self.generation);
                    self.approvals
                        .lock()
                        .await
                        .insert(v["id"].to_string(), approval);
                    self.emit("approval-requested", event);
                } else {
                    let _=self.write(json!({"id":v["id"],"error":{"code":-32601,"message":"Request type is not supported by Bindaas"}})).await;
                    self.emit("warning",json!({"threadId":p["threadId"],"turnId":p["turnId"],"message":format!("Unsupported server request: {method}. The request was rejected.")}));
                }
                return;
            }
            let thread = p["threadId"].as_str().unwrap_or("");
            let turn_id = p["turnId"].as_str().unwrap_or("");
            match method{
                "thread/name/updated"=>self.emit("thread-name",json!({"threadId":thread,"name":p["threadName"]})),
                "thread/started"=>self.emit("thread-name",json!({"threadId":p["thread"]["id"],"name":p["thread"]["name"],"projectRoot":p["thread"]["cwd"]})),
                "thread/archived"=>{self.resumed.lock().await.remove(thread);self.emit("thread-archived",json!({"threadId":thread}));},
                "thread/status/changed"=>self.emit("thread-status",json!({"threadId":thread,"status":p["status"]})),
                "thread/tokenUsage/updated"=>{
                    let usage=session::token_usage(&p["tokenUsage"],false);
                    let mut cache=self.usage.lock().await;
                    if cache.len()>=32 && !cache.contains_key(thread) {cache.clear();}
                    cache.insert(thread.into(),usage.clone());drop(cache);
                    self.emit("token-usage",json!({"threadId":thread,"usage":usage}));
                },
                "account/rateLimits/updated"=>self.emit("rate-limits-changed",json!({})),
                "thread/settings/updated"=>{
                    let settings=thread_settings::live(&p["threadSettings"]);
                    self.settings.lock().await.insert(thread.into(),settings.clone());
                    if let Some(changed)=self.settings_changed.lock().await.get(thread) {changed.notify_waiters();}
                    self.emit("thread-settings",json!({"threadId":thread,"settings":settings}));
                },
                "turn/started"=>{self.active.lock().await.insert(thread.into(),p["turn"]["id"].as_str().unwrap_or("").into());self.emit("turn-started",json!({"threadId":thread,"turn":normalize::turn(&p["turn"]),"settings":self.settings.lock().await.get(thread).cloned()}));},
                "turn/completed"=>{self.thinking.lock().await.remove(thread);let id=p["turn"]["id"].as_str().unwrap_or("");let mut active=self.active.lock().await;if active.get(thread).is_some_and(|r|r==id||r.is_empty()){active.remove(thread);}drop(active);self.approvals.lock().await.retain(|_,a|a.params["threadId"]!=thread||a.params["turnId"]!=id);self.emit("turn-completed",json!({"threadId":thread,"turn":normalize::turn(&p["turn"])}));},
                "item/started"|"item/completed"=>{if p["item"]["type"]=="reasoning" { let key=(turn_id.to_string(),p["item"]["id"].as_str().unwrap_or("").to_string());let mut thinking=self.thinking.lock().await;if method=="item/started" {thinking.insert(thread.into(),key);} else if thinking.get(thread)==Some(&key) {thinking.remove(thread);} }
                    if p["item"]["type"]=="commandExecution"{if let Some(s)=p["item"]["aggregatedOutput"].as_str(){self.retain_output(&format!("{}:{}:{}",thread,turn_id,p["item"]["id"].as_str().unwrap_or("")),s,true).await;}}
                    if let Some(i)=normalize::item(&p["item"],thread,turn_id,method=="item/completed"){self.emit("timeline-item",i);}},
                "turn/plan/updated"=>{if let Some(item)=normalize::progress(p){self.emit("timeline-item",item);}},
                "turn/diff/updated"=>{let diff=p["diff"].as_str().unwrap_or("");self.emit("turn-diff",json!({"threadId":thread,"turnId":turn_id,"diff":prefix(diff,DIFF_CAP),"truncated":diff.len()>DIFF_CAP}));},
                "serverRequest/resolved"=>{let id=p["requestId"].to_string();self.approvals.lock().await.remove(&id);let waiting=self.approvals.lock().await.values().any(|a|a.params["threadId"]==thread);self.emit("approval-resolved",json!({"requestId":id,"threadId":thread,"waiting":waiting}));},
                "account/login/completed"=>{self.login.store(false,Ordering::SeqCst);self.emit("auth-updated",json!({"success":p["success"],"error":p["error"],"loginId":p["loginId"]}));},
                "account/updated"=>self.emit("auth-updated",json!({"changed":true})),
                "error"=>self.emit("warning",json!({"threadId":thread,"turnId":turn_id,"message":p["error"]["message"],"willRetry":p["willRetry"]})),
                _=>{}
            }
        } else if let Some(id) = v["id"].as_u64() {
            if let Some(sender) = self.pending.lock().await.remove(&id) {
                let _ = sender.send(if v.get("error").is_some() {
                    Err(if v["error"]["code"] == -32601 {
                        "Your Codex version doesn't support this yet. Update Codex and try again."
                            .to_string()
                    } else {
                        v["error"]["message"]
                            .as_str()
                            .unwrap_or("Codex request failed")
                            .to_string()
                    })
                } else {
                    Ok(v["result"].clone())
                });
            }
        }
        self.wake.notify_one();
    }
    pub async fn respond(
        &self,
        generation: u64,
        id: &str,
        decision: Value,
        answers: Option<Value>,
    ) -> Result<(), String> {
        if generation != self.generation || !self.alive.load(Ordering::SeqCst) {
            return Err("Stale approval from an earlier connection".into());
        }
        let mut registry = self.approvals.lock().await;
        let approval = registry.get(id).ok_or("Approval already resolved")?;
        let response = approval.response(&decision, answers.as_ref())?;
        self.write(json!({"id":approval.id,"result":response}))
            .await?;
        let thread = approval.params["threadId"].clone();
        registry.remove(id);
        let waiting = registry.values().any(|a| a.params["threadId"] == thread);
        drop(registry);
        self.emit(
            "approval-resolved",
            json!({"requestId":id,"threadId":thread,"waiting":waiting}),
        );
        self.touch().await;
        Ok(())
    }
    async fn disconnect(&self, message: &str) {
        if self.alive.swap(false, Ordering::SeqCst) {
            for (_, tx) in self.pending.lock().await.drain() {
                let _ = tx.send(Err(message.into()));
            }
            self.approvals.lock().await.clear();
            self.emit(
                "connection",
                json!({"type":"disconnected","message":message}),
            );
            if let Some(tx) = self.shutdown.lock().await.take() {
                let _ = tx.send(());
            }
            self.wake.notify_one();
        }
    }
    /// Rejoin the owned running thread after a WebView reload without mutating its turn.
    /// The caller must verify the thread's project before invoking this method.
    pub async fn resume_or_attach(
        &self,
        thread_id: &str,
        _cwd: &Path,
        current: Value,
    ) -> Result<Value, String> {
        // Resolve an uncertain start using live Codex state without touching other threads.
        let uncertain = self
            .active
            .lock()
            .await
            .get(thread_id)
            .is_some_and(|turn| turn.is_empty());
        if uncertain {
            if current["thread"]["status"]["type"] == "active" {
                self.observe_resumed(&current).await?;
            } else if current["thread"]["status"]["type"] == "idle" {
                let mut active = self.active.lock().await;
                if active.get(thread_id).is_some_and(|turn| turn.is_empty()) {
                    active.remove(thread_id);
                }
            }
        }
        let active = self.active.lock().await.clone();
        if self.resumed.lock().await.contains_key(thread_id) || active.contains_key(thread_id) {
            let mut response = self
                .resumed
                .lock()
                .await
                .get(thread_id)
                .cloned()
                .unwrap_or_else(|| current.clone());
            response["thread"] = current["thread"].clone();
            // Live read metadata wins over the original resume response.
            response["model"] = current["thread"]["model"].clone();
            response["reasoningEffort"] = current["thread"]["reasoningEffort"].clone();
            return Ok(response);
        }
        let recorded = thread_settings::recorded(current["thread"].clone()).await;
        let resumed = self
            .request(
                "thread/resume",
                json!({"threadId":thread_id,"excludeTurns":true}),
            )
            .await?;
        self.observe_resumed(&resumed).await?;
        self.resumed
            .lock()
            .await
            .insert(thread_id.into(), resumed.clone());
        self.settings
            .lock()
            .await
            .entry(thread_id.into())
            .or_insert_with(|| thread_settings::resumed(&resumed));
        // This CLI version resumes with default collaboration mode even when its
        // own rollout says Plan. Reapply only Codex-owned recorded settings.
        if !self.active.lock().await.contains_key(thread_id) {
            if let Some(saved) = recorded.latest {
                let mut patch = json!({"threadId":thread_id});
                if let Some(model) = saved["model"].as_str() {
                    patch["model"] = json!(model);
                }
                if let Some(effort) = saved["effort"].as_str() {
                    patch["effort"] = json!(effort);
                }
                if !saved["mode"].is_null() {
                    patch["collaborationMode"] = json!({"mode":saved["mode"],"settings":{"model":saved["model"].as_str().or_else(|| resumed["model"].as_str()),"reasoning_effort":saved["effort"],"developer_instructions":null}});
                }
                if patch.as_object().is_some_and(|p| p.len() > 1) {
                    self.update_settings(patch).await?;
                }
            }
        }
        Ok(resumed)
    }

    pub async fn effective_settings(&self, id: &str, response: &Value) -> Value {
        let mut settings = self
            .settings
            .lock()
            .await
            .get(id)
            .cloned()
            .unwrap_or_else(|| thread_settings::resumed(response));
        if settings["mode"].is_null() {
            if let Some(saved) = thread_settings::recorded(response["thread"].clone())
                .await
                .latest
            {
                for key in ["model", "effort", "mode"] {
                    settings[key] = saved[key].clone();
                }
            }
        }
        settings
    }
    pub async fn update_settings(&self, patch: Value) -> Result<(), String> {
        // Register before the request: notification may arrive before or after its response.
        let thread = patch["threadId"].as_str().ok_or("Missing thread ID")?;
        let signal = self
            .settings_changed
            .lock()
            .await
            .entry(thread.into())
            .or_default()
            .clone();
        let changed = signal.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        self.request("thread/settings/update", patch).await?;
        // A no-op update legitimately has no notification.
        let _ = tokio::time::timeout(Duration::from_millis(500), changed).await;
        Ok(())
    }

    pub async fn observe_resumed(&self, response: &Value) -> Result<(), String> {
        if response["thread"]["status"]["type"] != "active" {
            return Ok(());
        }
        let id = response["thread"]["id"]
            .as_str()
            .ok_or("Missing resumed thread id")?;
        self.active.lock().await.entry(id.into()).or_default();
        let page = self
            .request(
                "thread/turns/list",
                json!({"threadId":id,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),
            )
            .await?;
        let running = page["data"]
            .as_array()
            .and_then(|turns| turns.iter().find(|t| t["status"] == "inProgress"));
        let mut active = self.active.lock().await;
        if active.get(id).is_some_and(|turn| turn.is_empty()) {
            if let Some(turn) = running.and_then(|t| t["id"].as_str()) {
                active.insert(id.into(), turn.into());
            } else {
                active.remove(id);
            }
        }
        self.wake.notify_one();
        Ok(())
    }
    pub async fn idle(&self) -> bool {
        self.active.lock().await.is_empty()
            && self.approvals.lock().await.is_empty()
            && self.pending.lock().await.is_empty()
            && !self.login.load(Ordering::SeqCst)
    }
    pub async fn stop(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.stdin.lock().await.take();
        let wait = async {
            while !self.exited.load(Ordering::SeqCst) {
                let notified = self.exit_notify.notified();
                if self.exited.load(Ordering::SeqCst) {
                    break;
                }
                notified.await;
            }
        };
        if tokio::time::timeout(Duration::from_millis(300), wait)
            .await
            .is_err()
        {
            if let Some(tx) = self.shutdown.lock().await.take() {
                let _ = tx.send(());
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                while !self.exited.load(Ordering::SeqCst) {
                    self.exit_notify.notified().await;
                }
            })
            .await;
        }
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err("Codex stopped".into()));
        }
        self.approvals.lock().await.clear();
        self.emit("connection", json!({"type":"sleeping"}));
    }
}

pub struct Manager {
    pub client: Option<Arc<Client>>,
    generation: u64,
    pub executable: Option<String>,
    pub idle_timeout: Duration,
    pub sink: Sink,
    pub wake: Arc<Notify>,
}
impl Manager {
    pub fn new(sink: Sink) -> Self {
        Self {
            client: None,
            generation: 0,
            executable: None,
            idle_timeout: Duration::from_secs(300),
            sink,
            wake: Arc::new(Notify::new()),
        }
    }
    pub async fn ready(&mut self) -> Result<Arc<Client>, String> {
        if let Some(c) = &self.client {
            if c.alive.load(Ordering::SeqCst) {
                return Ok(c.clone());
            }
        }
        self.generation += 1;
        (self.sink)(
            "codex://connection",
            json!({"type":"starting","generation":self.generation}),
        );
        let result = match discover(self.executable.as_deref()) {
            Ok(path) => {
                Client::spawn(&path, self.generation, self.sink.clone(), self.wake.clone()).await
            }
            Err(e) => Err(e),
        };
        match result {
            Ok(c) => {
                self.client = Some(c.clone());
                self.wake.notify_one();
                Ok(c)
            }
            Err(e) => {
                (self.sink)(
                    "codex://connection",
                    json!({"type":"failed","message":e,"generation":self.generation}),
                );
                Err(e)
            }
        }
    }
    pub async fn sleep(&mut self, force: bool) -> Result<(), String> {
        if let Some(c) = &self.client {
            if !force && !c.idle().await {
                return Err("Codex has active work, approvals, or login".into());
            }
            c.stop().await;
        }
        self.client = None;
        Ok(())
    }
}
/// Oldest Codex CLI whose app-server protocol Bindaas is tested against.
pub const MIN_CODEX_VERSION: (u32, u32, u32) = (0, 154, 0);

/// Reads the version from an app-server user agent such as
/// `codex_cli_rs/0.155.0 (Mac OS 26.0.0; arm64) …`. Unknown formats return None.
pub fn codex_version(user_agent: &str) -> Option<(u32, u32, u32)> {
    user_agent
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|token| {
            let mut parts = token.split('.').map(|p| p.parse::<u32>().ok());
            match (parts.next()?, parts.next()?, parts.next()?) {
                (Some(a), Some(b), Some(c)) => Some((a, b, c)),
                _ => None,
            }
        })
}

pub fn version_text((a, b, c): (u32, u32, u32)) -> String {
    format!("{a}.{b}.{c}")
}

pub fn valid_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    true
}
pub fn discover(override_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = override_path {
        let path = PathBuf::from(p);
        return if path.is_absolute() && valid_executable(&path) {
            Ok(path)
        } else {
            Err("Configured Codex executable is not an absolute executable file".into())
        };
    }
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    // Searches the user's shell PATH and common install locations, so Codex is found
    // even when the app was opened from Finder.
    crate::shell_env::find(name).ok_or_else(|| {
        "Codex CLI not found. Install it (npm install -g @openai/codex, or brew install codex), then reconnect — or choose its executable in Settings.".into()
    })
}
pub fn start_idle_task(manager: Arc<Mutex<Manager>>, wake: Arc<Notify>) {
    tokio::spawn(async move {
        loop {
            let next = {
                let m = manager.lock().await;
                if let Some(c) = &m.client {
                    if c.alive.load(Ordering::SeqCst) && c.idle().await {
                        Some(*c.touched.lock().await + m.idle_timeout)
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            match next {
                Some(deadline) => {
                    tokio::select! {_=wake.notified()=>{},_=tokio::time::sleep_until(deadline)=>{let mut m=manager.lock().await;let should=if let Some(c)=&m.client{c.idle().await&&c.touched.lock().await.elapsed()>=m.idle_timeout}else{false};if should{let _=m.sleep(false).await;}}}
                }
                None => wake.notified().await,
            }
        }
    });
}

#[cfg(test)]
mod version_tests {
    use super::*;

    #[test]
    fn reads_codex_versions_from_user_agents() {
        assert_eq!(
            codex_version("codex_cli_rs/0.155.0 (Mac OS 26.0.0; arm64) iTerm.app"),
            Some((0, 155, 0))
        );
        assert_eq!(codex_version("bindaas/1.2.3"), Some((1, 2, 3)));
        assert_eq!(codex_version("fixture"), None);
        assert!(codex_version("codex_cli_rs/0.153.9").unwrap() < MIN_CODEX_VERSION);
        assert!(codex_version("codex_cli_rs/0.154.0").unwrap() >= MIN_CODEX_VERSION);
        assert!(codex_version("codex_cli_rs/1.0.0").unwrap() >= MIN_CODEX_VERSION);
    }
}
