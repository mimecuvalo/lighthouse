//! Debug tool: `cargo run --release --bin analyze -- <file.mp3> [episode title substring]`
//! Prints detected segments and, given a title, the aligned tracklist from the live feed.

use std::path::{Path, PathBuf};

use lighthouse_lib::{align, analyze, feed};

fn fmt(t: f64) -> String {
    format!("{:02}:{:02}", (t / 60.0) as u64, (t % 60.0) as u64)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let audio = PathBuf::from(args.next().expect("usage: analyze <file.mp3> [title substring]"));
    let title = args.next();

    let episode = match &title {
        Some(t) => {
            let xml = feed::fetch_feed_xml().await?;
            Some(
                feed::parse_feed(&xml)
                    .into_iter()
                    .find(|e| e.title.contains(t.as_str()))
                    .ok_or_else(|| anyhow::anyhow!("no episode matching {t:?}"))?,
            )
        }
        None => None,
    };

    let model_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/yamnet.onnx");
    let mut model = analyze::load_model(&model_path)?;
    let started = std::time::Instant::now();
    let expected = episode.as_ref().map_or(0.0, |e| e.duration);
    let analysis = analyze::analyze(&mut model, &audio, expected, |_| {})?;
    eprintln!(
        "analyzed {} of audio in {:.1}s",
        fmt(analysis.duration),
        started.elapsed().as_secs_f64()
    );

    for s in &analysis.segments {
        println!("{} – {}  {:?}", fmt(s.start), fmt(s.end), s.kind);
    }

    if let Some(e) = episode {
        let ad_time = analysis.duration - e.duration;
        println!("\n{} (ads: {:+.0}s)", e.title, ad_time);
        for t in align::align(&e.tracklist, &analysis.segments, ad_time) {
            let marker = t.marker_time.map_or("  —  ".into(), fmt);
            let start = t.start.map_or("  ?  ".into(), fmt);
            let flag = if t.inferred { " (inferred)" } else { "" };
            println!("marker {marker} → {start}  {}{flag}", t.label);
        }
    }
    Ok(())
}
