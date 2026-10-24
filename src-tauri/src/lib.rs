pub mod align;
pub mod analyze;
pub mod feed;
pub mod store;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::align::Track;
use crate::analyze::Analysis;
use crate::feed::Episode;
use crate::store::Store;

struct AppState {
    store: Store,
    model_path: PathBuf,
    model: Mutex<Option<ort::session::Session>>,
    episodes: Mutex<Vec<Episode>>,
    /// Serializes downloads/analysis so two clicks don't fight over one file.
    preparing: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
struct EpisodeSummary {
    #[serde(flatten)]
    episode: Episode,
    ready: bool,
}

#[derive(Serialize)]
struct Prepared {
    guid: String,
    audio_path: PathBuf,
    analysis: Analysis,
    tracks: Vec<Track>,
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    guid: &'a str,
    stage: &'a str,
    progress: f64,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
async fn list_episodes(state: State<'_, AppState>, refresh: bool) -> CmdResult<Vec<EpisodeSummary>> {
    let cached = state.episodes.lock().unwrap().clone();
    let episodes = if !refresh && !cached.is_empty() {
        cached
    } else {
        let xml = match feed::fetch_feed_xml().await {
            Ok(xml) => {
                state.store.save_feed(&xml).map_err(err)?;
                xml
            }
            // Offline: fall back to the last feed we saw.
            Err(e) => state.store.load_feed().ok_or_else(|| err(e))?,
        };
        let parsed = feed::parse_feed(&xml);
        *state.episodes.lock().unwrap() = parsed.clone();
        parsed
    };
    Ok(episodes
        .into_iter()
        .map(|episode| EpisodeSummary { ready: state.store.is_ready(&episode.guid), episode })
        .collect())
}

#[tauri::command]
async fn prepare_episode(app: AppHandle, state: State<'_, AppState>, guid: String) -> CmdResult<Prepared> {
    let _guard = state.preparing.lock().await;
    let episode = state
        .episodes
        .lock()
        .unwrap()
        .iter()
        .find(|e| e.guid == guid)
        .cloned()
        .ok_or("unknown episode")?;

    let audio_path = state.store.audio_path(&guid);
    if !audio_path.exists() {
        store::download(&episode.audio_url, &audio_path, |progress| {
            let _ = app.emit("prepare-progress", Progress { guid: &guid, stage: "download", progress });
        })
        .await
        .map_err(err)?;
    }

    let analysis = match state.store.load_analysis(&guid) {
        Some(a) => a,
        None => {
            let app = app.clone();
            let guid_for_task = guid.clone();
            let audio = audio_path.clone();
            let model_path = state.model_path.clone();
            let duration = episode.duration;
            // Take the loaded model out of state for the blocking task, and put it back after.
            let cached_model = state.model.lock().unwrap().take();
            let (result, model) = tauri::async_runtime::spawn_blocking(move || {
                let mut model = match cached_model {
                    Some(m) => m,
                    None => match analyze::load_model(&model_path) {
                        Ok(m) => m,
                        Err(e) => return (Err(e), None),
                    },
                };
                let result = analyze::analyze(&mut model, &audio, duration, |progress| {
                    let _ = app.emit("prepare-progress", Progress { guid: &guid_for_task, stage: "analyze", progress });
                });
                (result, Some(model))
            })
            .await
            .map_err(err)?;
            *state.model.lock().unwrap() = model;
            let analysis = result.map_err(err)?;
            state.store.save_analysis(&guid, &analysis).map_err(err)?;
            analysis
        }
    };

    let tracks = align::align(&episode.tracklist, &analysis.segments, analysis.duration - episode.duration);
    Ok(Prepared { guid, audio_path, analysis, tracks })
}

#[tauri::command]
fn delete_episode(state: State<'_, AppState>, guid: String) -> CmdResult<()> {
    state.store.delete(&guid).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let model_path = app
                .path()
                .resolve("resources/yamnet.onnx", tauri::path::BaseDirectory::Resource)?;
            app.manage(AppState {
                store: Store::new(data_dir)?,
                model_path,
                model: Mutex::new(None),
                episodes: Mutex::new(Vec::new()),
                preparing: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_episodes, prepare_episode, delete_episode])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
