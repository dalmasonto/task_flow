//! #525: `deliver` — rendering FOR THE HUMAN, without loading the image into
//! the agent.
//!
//! A compare reply's text is lean since 2.10.0, which left the IMAGE as the
//! cost: on a 4-colour × 2-theme grid it was ~65% of the reply's tokens, spent
//! on a picture the agent often does not need — the human asked for it. The
//! old workaround was three steps (render at full size, `cp` the PNG out of
//! tool-results, then upload it again with `send_message`), every one of them
//! avoidable.
//!
//! `deliver` makes the renderer itself the delivery route:
//!
//! - `inline` (default): today's behaviour — the image comes back to the agent.
//! - `message`: the render is stored and posted as an attachment of ONE
//!   message in the named channel, and the agent gets ids and sizes instead of
//!   pixels. The channel and the membership rule are the message route's own
//!   (`taskflow_agents::posting`), so a render lands only where the agent could
//!   have posted a sentence.
//! - `url`: the render is stored and the response carries where it lives —
//!   for a caller that wants the picture without the pixels.
//!
//! `checks`, grid labels and warnings are returned in EVERY mode: they are
//! what the agent reasons about, and they are text.

use serde::Deserialize;

use taskflow_agents::agent_auth::AgentIdentity;

/// The `deliver` object the design tools accept. Absent = `inline`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Deliver {
    /// `inline` (default) | `message` | `url`.
    #[serde(default)]
    pub to: Option<String>,
    /// Required by `message`: the channel to post in.
    #[serde(default)]
    pub channel: Option<i64>,
    /// Optional message text.
    #[serde(default)]
    pub body: Option<String>,
    /// `message` only: post as a reply to this message in the same channel.
    #[serde(default)]
    pub reply_to: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    Inline,
    Message { channel: i64, body: Option<String>, reply_to: Option<i64> },
    Media,
}

impl Deliver {
    /// Parse the mode, refusing an unknown one and a `message` with no channel
    /// BEFORE anything renders — a 400 beats a wasted page load.
    pub fn parse(&self) -> Result<Delivery, String> {
        match self.to.as_deref().map(str::trim) {
            None | Some("") | Some("inline") => Ok(Delivery::Inline),
            Some("message") => {
                let channel = self
                    .channel
                    .ok_or_else(|| "deliver.to \"message\" needs a `channel` id".to_string())?;
                Ok(Delivery::Message { channel, body: self.body.clone(), reply_to: self.reply_to })
            }
            Some("url") => Ok(Delivery::Media),
            Some(other) => Err(format!(
                "unknown deliver.to `{other}` (inline, message, url)"
            )),
        }
    }
}

/// One rendered image on its way out.
pub struct RenderedImage {
    pub filename: String,
    pub png: Vec<u8>,
    /// Pixel size, carried through to the delivery record so the caller can
    /// describe the picture without decoding it.
    pub width: u32,
    pub height: u32,
}

/// Deliver the renders and answer with the JSON that REPLACES the base64
/// payloads in the tool response. `Ok(None)` means "inline: nothing to add".
pub async fn deliver(
    agent: &AgentIdentity,
    delivery: &Delivery,
    images: Vec<RenderedImage>,
) -> Result<Option<serde_json::Value>, (umbral::web::StatusCode, String)> {
    use umbral::web::StatusCode;
    match delivery {
        Delivery::Inline => Ok(None),
        Delivery::Message { channel, body, reply_to } => {
            let channel_row = taskflow_agents::posting::postable_channel(agent, *channel)
                .await
                .map_err(|err| match err {
                    taskflow_agents::posting::PostError::ChannelNotFound => {
                        (StatusCode::NOT_FOUND, format!("no channel {channel}"))
                    }
                    taskflow_agents::posting::PostError::NotAllowed => (
                        StatusCode::FORBIDDEN,
                        format!(
                            "you cannot post to channel {channel}: it is another project's room, or a DM you are not on"
                        ),
                    ),
                    _ => (StatusCode::INTERNAL_SERVER_ERROR, "could not resolve the channel".into()),
                })?;
            // A render is the message's whole content, but a body is always
            // allowed to say what it shows.
            let text = body
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("Design render ({} image(s)).", images.len()));
            let files: Vec<taskflow_agents::posting::OutgoingFile> = images
                .iter()
                .map(|image| taskflow_agents::posting::OutgoingFile {
                    filename: image.filename.clone(),
                    content_type: "image/png".to_string(),
                    bytes: image.png.clone(),
                })
                .collect();
            let (message, attachments) = taskflow_agents::posting::post_agent_message(
                agent,
                &channel_row,
                &text,
                *reply_to,
                files,
            )
            .await
            .map_err(|err| match err {
                taskflow_agents::posting::PostError::TooLarge { name, max_mb } => (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("\"{name}\" is over the {max_mb} MB attachment cap; lower `max_px` and retry"),
                ),
                taskflow_agents::posting::PostError::StorageUnavailable => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "no storage backend is registered for attachments".into(),
                ),
                _ => (StatusCode::INTERNAL_SERVER_ERROR, "could not post the render".into()),
            })?;
            let records: Vec<serde_json::Value> = attachments
                .iter()
                .zip(images.iter())
                .map(|(attachment, image)| {
                    let mut value = taskflow_agents::posting::attachment_json(attachment);
                    value["width"] = serde_json::json!(image.width);
                    value["height"] = serde_json::json!(image.height);
                    value
                })
                .collect();
            Ok(Some(serde_json::json!({
                "delivered": {
                    "to": "message",
                    "message_id": message.id,
                    "channel": message.channel.id(),
                    "body": text,
                    "attachments": records,
                    "note": "The render went to the channel, not to you: no image is in this reply. Do not re-send it.",
                }
            })))
        }
        Delivery::Media => {
            let mut records = Vec::with_capacity(images.len());
            for image in &images {
                let stored = taskflow_agents::posting::store_media(
                    &image.filename,
                    "image/png",
                    &image.png,
                )
                .await
                .map_err(|err| match err {
                    taskflow_agents::posting::PostError::StorageUnavailable => (
                        umbral::web::StatusCode::INTERNAL_SERVER_ERROR,
                        "no storage backend is registered for media".to_string(),
                    ),
                    _ => (umbral::web::StatusCode::INTERNAL_SERVER_ERROR, "could not store the render".to_string()),
                })?;
                records.push(serde_json::json!({
                    "url": stored.url,
                    "file": stored.key,
                    "bytes": stored.size,
                    "width": image.width,
                    "height": image.height,
                }));
            }
            Ok(Some(serde_json::json!({
                "delivered": { "to": "url", "images": records }
            })))
        }
    }
}

/// A safe filename stem for a delivered render, e.g. `settings--dark.png`.
pub fn render_filename(route: &str, suffix: &str) -> String {
    let slug = |text: &str| {
        text.trim_matches('/')
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    };
    let route = slug(route);
    let route = if route.is_empty() { "index".to_string() } else { route };
    let suffix = slug(suffix);
    if suffix.is_empty() {
        format!("{route}.png")
    } else {
        format!("{route}--{suffix}.png")
    }
}
