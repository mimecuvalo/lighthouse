use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::analyze::{self, Analysis};

/// Files live under the app data dir: `feed.xml` and `episodes/<id>.{mp3,json}`.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir.join("episodes"))?;
        Ok(Store { dir })
    }

    fn file_id(guid: &str) -> String {
        if !guid.is_empty() && guid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            guid.to_string()
        } else {
            sha1_smol::Sha1::from(guid).digest().to_string()
        }
    }

    pub fn audio_path(&self, guid: &str) -> PathBuf {
        self.dir.join("episodes").join(format!("{}.mp3", Self::file_id(guid)))
    }

    fn analysis_path(&self, guid: &str) -> PathBuf {
        self.dir.join("episodes").join(format!("{}.json", Self::file_id(guid)))
    }

    pub fn is_ready(&self, guid: &str) -> bool {
        self.audio_path(guid).exists() && self.load_analysis(guid).is_some()
    }

    pub fn load_analysis(&self, guid: &str) -> Option<Analysis> {
        let json = std::fs::read(self.analysis_path(guid)).ok()?;
        let analysis: Analysis = serde_json::from_slice(&json).ok()?;
        (analysis.version == analyze::VERSION).then_some(analysis)
    }

    pub fn save_analysis(&self, guid: &str, analysis: &Analysis) -> anyhow::Result<()> {
        std::fs::write(self.analysis_path(guid), serde_json::to_vec(analysis)?)?;
        Ok(())
    }

    pub fn delete(&self, guid: &str) -> std::io::Result<()> {
        for path in [self.audio_path(guid), self.analysis_path(guid)] {
            match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
    }

    pub fn save_feed(&self, xml: &str) -> std::io::Result<()> {
        std::fs::write(self.dir.join("feed.xml"), xml)
    }

    pub fn load_feed(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join("feed.xml")).ok()
    }
}

/// Streams `url` to `dest`, reporting the fraction downloaded.
pub async fn download(url: &str, dest: &Path, mut on_progress: impl FnMut(f64)) -> anyhow::Result<()> {
    let res = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "lighthouse/0.1")
        .send()
        .await?
        .error_for_status()?;
    let total = res.content_length().unwrap_or(0) as f64;
    let partial = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await?;
    let mut received = 0u64;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if total > 0.0 {
            on_progress(received as f64 / total);
        }
    }
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&partial, dest).await?;
    Ok(())
}
