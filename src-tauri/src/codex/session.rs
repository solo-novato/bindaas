use super::Client;
use serde_json::{json, Value};
use std::path::Path;

/// Permissions for conversations started in the app, from the user's
/// "New conversations start with" preference. Only new threads receive these;
/// existing conversations are never changed implicitly.
pub fn new_chat_permissions(access: &str) -> (&'static str, &'static str) {
    if access == "full" {
        (":danger-full-access", "never")
    } else {
        (":workspace", "on-request")
    }
}

pub async fn permission_options(c: &Client, cwd: &Path) -> Result<Value, String> {
    let requirements = c.request("configRequirements/read", json!({}));
    let profiles = async {
        let mut data = vec![];
        let mut cursor = Value::Null;
        loop {
            let page = c
                .request(
                    "permissionProfile/list",
                    json!({"cwd":cwd,"limit":100,"cursor":cursor}),
                )
                .await?;
            if let Some(entries) = page["data"].as_array() {
                data.extend(entries.iter().map(|p| json!({"id":p["id"],"description":p["description"],"allowed":p["allowed"] == true})));
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
            if data.len() >= 500 {
                return Err("Too many permission profiles to display".to_string());
            }
        }
        Ok::<_, String>(data)
    };
    let (requirements, profiles) = tokio::join!(requirements, profiles);
    let requirements = requirements?;
    let allowed = &requirements["requirements"]["allowedApprovalPolicies"];
    let policies: Vec<Value> = ["untrusted", "on-request", "never"]
        .into_iter()
        .filter(|p| allowed.is_null() || allowed.as_array().is_some_and(|a| a.contains(&json!(p))))
        .map(|p| json!(p))
        .collect();
    Ok(json!({"profiles":profiles?,"approvalPolicies":policies}))
}
pub fn validate_permissions(
    options: &Value,
    profile: Option<&str>,
    policy: Option<&str>,
) -> Result<(), String> {
    if let Some(profile) = profile {
        if !options["profiles"]
            .as_array()
            .is_some_and(|p| p.iter().any(|p| p["id"] == profile && p["allowed"] == true))
        {
            return Err("Codex does not allow this permission profile for the project".into());
        }
    }
    if let Some(policy) = policy {
        if !options["approvalPolicies"]
            .as_array()
            .is_some_and(|p| p.contains(&json!(policy)))
        {
            return Err("Codex does not allow this approval policy".into());
        }
    }
    Ok(())
}
fn count(value: &Value) -> Value {
    value.as_u64().map_or(Value::Null, |n| json!(n))
}
fn breakdown(value: &Value, snake: bool) -> Value {
    let mut out = json!({});
    for (camel, underscored) in [
        ("totalTokens", "total_tokens"),
        ("inputTokens", "input_tokens"),
        ("cachedInputTokens", "cached_input_tokens"),
        ("outputTokens", "output_tokens"),
    ] {
        out[camel] = count(&value[if snake { underscored } else { camel }]);
    }
    out
}
pub fn token_usage(value: &Value, snake: bool) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    json!({"total":breakdown(&value[if snake {"total_token_usage"} else {"total"}],snake),
        "last":breakdown(&value[if snake {"last_token_usage"} else {"last"}],snake),
        "modelContextWindow":count(&value[if snake {"model_context_window"} else {"modelContextWindow"}])})
}
pub fn limits(value: &Value) -> Value {
    let buckets: Vec<&Value> = if let Some(map) = value["rateLimitsByLimitId"].as_object() {
        map.values().take(30).collect()
    } else if value["rateLimits"].is_object() {
        vec![&value["rateLimits"]]
    } else {
        vec![]
    };
    let buckets: Vec<Value> = buckets.iter().map(|b| {
        let window = |name: &str| {
            let w = &b[name];
            if !w.is_object() {return Value::Null;}
            json!({"usedPercent":w["usedPercent"],"windowDurationMins":w["windowDurationMins"],"resetsAt":w["resetsAt"]})
        };
        json!({"id":b["limitId"],"name":b["limitName"],"plan":b["planType"],"primary":window("primary"),"secondary":window("secondary")})
    }).collect();
    json!({"buckets":buckets,"ordinaryUsageAllowed":value["ordinaryUsageAllowed"]})
}

pub async fn set_permissions(
    c: &Client,
    root: &Path,
    thread_id: &str,
    current: Value,
    permissions: Option<&str>,
    approval_policy: Option<&str>,
) -> Result<Value, String> {
    if c.active.lock().await.contains_key(thread_id)
        || c.approvals
            .lock()
            .await
            .values()
            .any(|a| a.params["threadId"] == thread_id)
    {
        return Err("Finish or stop the current task before changing permissions".into());
    }
    let v = c.resume_or_attach(thread_id, root, current).await?;
    if c.active.lock().await.contains_key(thread_id) {
        return Err("Finish or stop the current task before changing permissions".into());
    }
    let options = permission_options(c, root).await?;
    validate_permissions(&options, permissions, approval_policy)?;
    let mut patch = json!({"threadId":thread_id});
    if let Some(profile) = permissions {
        patch["permissions"] = json!(profile);
    }
    if let Some(policy) = approval_policy {
        patch["approvalPolicy"] = json!(policy);
    }
    if patch.as_object().is_some_and(|p| p.len() > 1) {
        c.update_settings(patch).await?;
    }
    Ok(c.effective_settings(thread_id, &v).await)
}

#[cfg(test)]
mod tests {
    use super::new_chat_permissions;

    #[test]
    fn new_chats_default_to_standard_access_unless_full_is_chosen() {
        assert_eq!(
            new_chat_permissions("standard"),
            (":workspace", "on-request")
        );
        assert_eq!(new_chat_permissions(""), (":workspace", "on-request"));
        assert_eq!(
            new_chat_permissions("anything"),
            (":workspace", "on-request")
        );
        assert_eq!(
            new_chat_permissions("full"),
            (":danger-full-access", "never")
        );
    }
}
