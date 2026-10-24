//! OpenAI's models through a real Nisse server, against a fake ChatGPT backend: which ones a
//! client can choose, and what a choice sends.

mod common;

use common::{ACCOUNT, DIRECT_MODEL, Fake, Nisse, PROVIDER, access_token, sign_in};
use nisse_protocol::{
    ClientRequest, Conversation, ConversationSelectModelParams, ModelInfo, ModelSelection,
    ModelsListParams, ModelsListResult,
};
use serde_json::{Value, json};

async fn listed(nisse: &Nisse) -> Vec<ModelInfo> {
    let listed: ModelsListResult = nisse
        .client
        .request(ClientRequest::ModelsList(ModelsListParams::default()))
        .await
        .unwrap();
    listed.providers.into_iter().next().unwrap().models
}

fn ids(models: &[ModelInfo]) -> Vec<&str> {
    models.iter().map(|model| model.id.as_str()).collect()
}

fn chatgpt_lists() -> Value {
    json!({ "models": [
        {
            "slug": "gpt-later",
            "display_name": "GPT Later",
            "description": "The second best",
            "visibility": "list",
            "priority": 2,
            "tool_mode": "code_mode_only",
            "context_window": 272000,
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                { "effort": "low", "description": "Quick" },
                { "effort": "high", "description": "Deep" },
            ],
            "shell_type": "shell_command",
            "model_messages": { "instructions_template": "unused" },
        },
        { "slug": "gpt-first", "display_name": "GPT First", "visibility": "list", "priority": 1 },
        { "slug": "gpt-reviewer", "visibility": "hide", "priority": 0 },
    ] })
}

#[tokio::test]
async fn a_client_chooses_from_what_chatgpt_lists_best_first_and_later_starts_remember_it() {
    let fake = Fake::start().await;
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    let model_list = home.path().join("cache/openai-models.json");
    fake.issue_tokens("first", 3600);
    sign_in(&fake, &auth_path).await;
    fake.list_models(chatgpt_lists());
    let saving = model_list.clone();
    let nisse = Nisse::with(&fake, &auth_path, DIRECT_MODEL, move |options| {
        options.model_list = saving;
    })
    .await;

    let fresh = listed(&nisse).await;
    let offline = Fake::start().await;
    let restarted = Nisse::with(&offline, &auth_path, DIRECT_MODEL, |options| {
        options.model_list = model_list;
    })
    .await;
    let remembered = listed(&restarted).await;

    assert_eq!(ids(&fresh), ["gpt-first", "gpt-later"]);
    assert_eq!(
        fresh[1],
        ModelInfo {
            id: "gpt-later".into(),
            name: "GPT Later".into(),
            description: Some("The second best".into()),
            efforts: vec!["low".into(), "high".into()],
            default_effort: Some("medium".into()),
            context_window: Some(272000),
            code_mode: true,
        }
    );
    let asked = &fake.received("/codex/models")[0];
    assert_eq!(asked.target, "/codex/models?client_version=0.164.0");
    assert_eq!(
        asked.headers["authorization"],
        format!("Bearer {}", access_token("first"))
    );
    assert_eq!(asked.headers["chatgpt-account-id"], ACCOUNT);
    assert_eq!(remembered, fresh);
}

#[tokio::test]
async fn signed_out_a_client_chooses_from_the_models_codex_bundles() {
    let fake = Fake::start().await;
    let home = tempfile::tempdir().unwrap();
    let nisse = Nisse::start(&fake, &home.path().join("openai.json")).await;

    let models = listed(&nisse).await;

    assert_eq!(
        ids(&models),
        [
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
        ]
    );
    assert!(models[0].code_mode);
    assert!(!models[7].code_mode);
}

#[tokio::test]
async fn the_next_request_names_the_model_and_effort_switched_to_and_keeps_the_transcript() {
    let fake = Fake::start().await;
    let home = tempfile::tempdir().unwrap();
    let auth_path = home.path().join("openai.json");
    fake.issue_tokens("first", 3600);
    sign_in(&fake, &auth_path).await;
    fake.play("text_answer");
    fake.play("text_answer");
    let mut nisse = Nisse::start(&fake, &auth_path).await;

    nisse.converse("hello", true).await;
    let _: Conversation = nisse
        .client
        .request(ClientRequest::ConversationSelectModel(
            ConversationSelectModelParams {
                conversation_id: nisse.conversation.id.clone(),
                selection: ModelSelection {
                    provider: PROVIDER.into(),
                    model: Some("gpt-5.5-mini".into()),
                    effort: Some("high".into()),
                },
            },
        ))
        .await
        .unwrap();
    nisse.converse("and again", true).await;

    let sent: Vec<Value> = fake
        .received("/codex/responses")
        .iter()
        .map(|request| request.json())
        .collect();
    assert_eq!(sent[0]["model"], DIRECT_MODEL);
    assert_eq!(sent[0].get("reasoning"), None);
    assert_eq!(sent[1]["model"], "gpt-5.5-mini");
    assert_eq!(sent[1]["reasoning"], json!({ "effort": "high" }));
    let said: Vec<&str> = sent[1]["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["content"][0]["text"].as_str().unwrap())
        .collect();
    assert_eq!(said, ["hello", "Hello there", "and again"]);
}
