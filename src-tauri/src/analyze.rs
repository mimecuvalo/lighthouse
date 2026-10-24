use std::path::Path;

use anyhow::{Context, anyhow};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Bump when the analysis output changes so cached results get recomputed.
pub const VERSION: u32 = 2;

const RATE: u32 = 16_000;
/// YAMNet emits one frame per 0.48 s (7680 samples), each covering 0.96 s.
const FRAME_HOP: usize = 7_680;
const FRAME_WINDOW: usize = 15_600;
const FRAMES_PER_CHUNK: usize = 250;
const CHUNK_SAMPLES: usize = FRAME_WINDOW + FRAME_HOP * (FRAMES_PER_CHUNK - 1);
const PEAK_HOP: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Music,
    Speech,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub kind: Kind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Analysis {
    pub version: u32,
    pub duration: f64,
    pub frame_hop: f64,
    /// Smoothed music-minus-speech score per frame, in [-1, 1].
    pub music_score: Vec<f32>,
    pub peak_hop: f64,
    pub peaks: Vec<f32>,
    pub segments: Vec<Segment>,
}

pub fn load_model(path: &Path) -> anyhow::Result<Session> {
    static ENV: std::sync::OnceLock<ort::environment::Environment> = std::sync::OnceLock::new();
    let env = match ENV.get() {
        Some(env) => env,
        None => {
            let env = ort::init().with_name("lighthouse").build()?;
            ENV.get_or_init(|| env)
        }
    };
    Ok(Session::builder(env)?.commit_from_file(path)?)
}

/// Decodes `audio`, classifies speech vs. music, and finds music segments.
/// `on_progress` gets the fraction of `expected_duration` processed so far.
pub fn analyze(
    model: &mut Session,
    audio: &Path,
    expected_duration: f64,
    mut on_progress: impl FnMut(f64),
) -> anyhow::Result<Analysis> {
    let file = std::fs::File::open(audio).with_context(|| format!("opening {}", audio.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let mut format = symphonia::default::get_probe().probe(
        &hint,
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| anyhow!("no audio track"))?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("no audio codec parameters"))?;
    let mut decoder =
        symphonia::default::get_codecs().make_audio_decoder(codec_params, &AudioDecoderOptions::default())?;

    let mut resampler: Option<Resampler> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut pending: Vec<f32> = Vec::new();
    let mut scores: Vec<(f32, f32)> = Vec::new();
    let mut peaks = PeakTracker::new((PEAK_HOP * RATE as f64) as usize);
    let mut total_out = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(err) => return Err(err.into()),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_) | SymphoniaError::IoError(_)) => continue,
            Err(err) => return Err(err.into()),
        };
        let channels = decoded.spec().channels().count().max(1);
        let rate = decoded.spec().rate();
        decoded.copy_to_vec_interleaved(&mut interleaved);

        mono.clear();
        mono.extend(
            interleaved
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        let resampler = resampler.get_or_insert_with(|| Resampler::new(rate, RATE));
        let before = pending.len();
        resampler.process(&mono, &mut pending);
        peaks.push(&pending[before..]);
        total_out += pending.len() - before;

        while pending.len() >= CHUNK_SAMPLES {
            let frames = classify(model, &pending[..CHUNK_SAMPLES])?;
            let used = frames.len().min(FRAMES_PER_CHUNK);
            scores.extend_from_slice(&frames[..used]);
            pending.drain(..used * FRAME_HOP);
            if expected_duration > 0.0 {
                on_progress((total_out as f64 / RATE as f64 / expected_duration).min(0.99));
            }
        }
    }
    if pending.len() >= FRAME_HOP {
        if pending.len() < FRAME_WINDOW {
            pending.resize(FRAME_WINDOW, 0.0);
        }
        let frames = classify(model, &pending)?;
        let wanted = pending.len().div_ceil(FRAME_HOP);
        scores.extend_from_slice(&frames[..frames.len().min(wanted)]);
    }

    let duration = total_out as f64 / RATE as f64;
    let music_score = smooth(&scores.iter().map(|(m, s)| m - s).collect::<Vec<_>>(), 11);
    let segments = segment(&music_score, FRAME_HOP as f64 / RATE as f64, duration);
    on_progress(1.0);
    Ok(Analysis {
        version: VERSION,
        duration,
        frame_hop: FRAME_HOP as f64 / RATE as f64,
        music_score: music_score.iter().map(|v| (v * 1000.0).round() / 1000.0).collect(),
        peak_hop: PEAK_HOP,
        peaks: peaks.finish(),
        segments,
    })
}

/// Runs YAMNet over a 16 kHz waveform, returning (music, speech) scores per frame.
fn classify(model: &mut Session, waveform: &[f32]) -> anyhow::Result<Vec<(f32, f32)>> {
    let input = Tensor::from_array(([waveform.len()], waveform.to_vec()))?;
    let outputs = model.run(ort::inputs!["waveform" => input])?;
    let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
    let classes = *shape.last().ok_or_else(|| anyhow!("empty output shape"))? as usize;
    Ok(data
        .chunks_exact(classes)
        .map(|row| {
            // 0–3: speech, conversation, narration. 24–32: singing/rapping. 132–276: music.
            let speech = row[0..=3].iter().copied().fold(0.0, f32::max);
            let music = row[132..=276]
                .iter()
                .chain(&row[24..=32])
                .copied()
                .fold(0.0, f32::max);
            (music, speech)
        })
        .collect())
}

fn smooth(values: &[f32], window: usize) -> Vec<f32> {
    let half = window / 2;
    let mut buf = Vec::with_capacity(window);
    (0..values.len())
        .map(|i| {
            buf.clear();
            buf.extend_from_slice(&values[i.saturating_sub(half)..(i + half + 1).min(values.len())]);
            buf.sort_by(f32::total_cmp);
            buf[buf.len() / 2]
        })
        .collect()
}

const ENTER_MUSIC: f32 = 0.1;
const EXIT_MUSIC: f32 = -0.1;
const MIN_MUSIC: f64 = 10.0;
/// Quiet passages inside a song can read as non-music for a few seconds; talk between songs runs longer.
const MAX_GAP: f64 = 12.0;

/// Turns per-frame scores into alternating music/speech segments covering `[0, duration]`.
pub fn segment(score: &[f32], hop: f64, duration: f64) -> Vec<Segment> {
    let mut music_runs: Vec<(f64, f64)> = Vec::new();
    let mut in_music = false;
    let mut start = 0.0;
    for (i, &v) in score.iter().enumerate() {
        let t = i as f64 * hop;
        if !in_music && v > ENTER_MUSIC {
            in_music = true;
            start = t;
        } else if in_music && v < EXIT_MUSIC {
            in_music = false;
            music_runs.push((start, t));
        }
    }
    if in_music {
        music_runs.push((start, duration));
    }

    let mut merged: Vec<(f64, f64)> = Vec::new();
    for run in music_runs {
        match merged.last_mut() {
            Some(last) if run.0 - last.1 < MAX_GAP => last.1 = run.1,
            _ => merged.push(run),
        }
    }
    merged.retain(|(s, e)| e - s >= MIN_MUSIC);

    let mut segments = Vec::new();
    let mut cursor = 0.0;
    for (s, e) in merged {
        if s > cursor {
            segments.push(Segment { start: cursor, end: s, kind: Kind::Speech });
        }
        segments.push(Segment { start: s, end: e.min(duration), kind: Kind::Music });
        cursor = e;
    }
    if cursor < duration {
        segments.push(Segment { start: cursor, end: duration, kind: Kind::Speech });
    }
    segments
}

/// Band-limited streaming resampler using a windowed-sinc table.
struct Resampler {
    step: f64,
    /// Absolute source index of `buf[0]`.
    buf_start: usize,
    buf: Vec<f32>,
    /// Absolute source position of the next output sample.
    pos: f64,
    table: Vec<f32>,
}

const HALF_TAPS: usize = 16;
const PHASES: usize = 256;

impl Resampler {
    fn new(from: u32, to: u32) -> Self {
        let step = from as f64 / to as f64;
        // Low-pass a little under the target Nyquist, relative to the source rate.
        let cutoff = 0.45 * to as f64 / from as f64;
        let taps = HALF_TAPS * 2;
        let mut table = vec![0f32; PHASES * taps];
        for p in 0..PHASES {
            let frac = p as f64 / PHASES as f64;
            let mut sum = 0.0;
            for k in 0..taps {
                // Tap k reads source sample floor(pos) - HALF_TAPS + 1 + k.
                let x = (k as f64 - (HALF_TAPS as f64 - 1.0)) - frac;
                let sinc = if x.abs() < 1e-9 {
                    2.0 * cutoff
                } else {
                    (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
                };
                let w = 0.5 + 0.5 * (std::f64::consts::PI * x / HALF_TAPS as f64).cos();
                let v = sinc * w;
                table[p * taps + k] = v as f32;
                sum += v;
            }
            for k in 0..taps {
                table[p * taps + k] /= sum as f32;
            }
        }
        Resampler { step, buf_start: 0, buf: Vec::new(), pos: 0.0, table }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let taps = HALF_TAPS * 2;
        if self.buf.is_empty() {
            // Prime with silence so the first outputs have history.
            self.buf.resize(HALF_TAPS, 0.0);
            self.buf_start = 0;
            self.pos = HALF_TAPS as f64;
        }
        self.buf.extend_from_slice(input);
        let buf_end = self.buf_start + self.buf.len();
        loop {
            let base = self.pos.floor() as usize;
            if base + HALF_TAPS >= buf_end {
                break;
            }
            let phase = (((self.pos - base as f64) * PHASES as f64) as usize).min(PHASES - 1);
            let coeffs = &self.table[phase * taps..(phase + 1) * taps];
            let first = base + 1 - HALF_TAPS - self.buf_start;
            let window = &self.buf[first..first + taps];
            out.push(window.iter().zip(coeffs).map(|(a, b)| a * b).sum());
            self.pos += self.step;
        }
        let keep_from = (self.pos.floor() as usize).saturating_sub(HALF_TAPS) .max(self.buf_start);
        self.buf.drain(..keep_from - self.buf_start);
        self.buf_start = keep_from;
    }
}

struct PeakTracker {
    hop: usize,
    count: usize,
    current: f32,
    peaks: Vec<f32>,
}

impl PeakTracker {
    fn new(hop: usize) -> Self {
        PeakTracker { hop, count: 0, current: 0.0, peaks: Vec::new() }
    }

    fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            self.current = self.current.max(s.abs());
            self.count += 1;
            if self.count == self.hop {
                self.peaks.push((self.current.min(1.0) * 1000.0).round() / 1000.0);
                self.count = 0;
                self.current = 0.0;
            }
        }
    }

    fn finish(mut self) -> Vec<f32> {
        if self.count > 0 {
            self.peaks.push((self.current.min(1.0) * 1000.0).round() / 1000.0);
        }
        self.peaks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_keeps_rate_and_tone() {
        let from = 44_100;
        let input: Vec<f32> = (0..from * 2)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / from as f32).sin())
            .collect();
        let mut r = Resampler::new(from as u32, RATE);
        let mut out = Vec::new();
        for chunk in input.chunks(1152) {
            r.process(chunk, &mut out);
        }
        assert!((out.len() as i64 - 2 * RATE as i64).abs() < 64, "len {}", out.len());
        let peak = out[1000..30000].iter().copied().fold(0.0, f32::max);
        assert!((peak - 1.0).abs() < 0.05, "peak {peak}");
    }

    #[test]
    fn resampler_filters_above_nyquist() {
        let from = 44_100;
        let input: Vec<f32> = (0..from)
            .map(|i| (2.0 * std::f32::consts::PI * 12_000.0 * i as f32 / from as f32).sin())
            .collect();
        let mut r = Resampler::new(from as u32, RATE);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        let peak = out[1000..10000].iter().map(|v| v.abs()).fold(0.0, f32::max);
        assert!(peak < 0.1, "aliased peak {peak}");
    }

    #[test]
    fn segments_merge_gaps_and_drop_short_runs() {
        let hop = 0.5;
        // 0–20 s speech, 20–60 s music with a 1 s dip at 40 s, 60–75 s speech, 75–80 s music blip.
        let score: Vec<f32> = (0..160)
            .map(|i| {
                let t = i as f64 * hop;
                let music = (20.0..60.0).contains(&t) && !(40.0..41.0).contains(&t) || (75.0..80.0).contains(&t);
                if music { 0.6 } else { -0.6 }
            })
            .collect();
        let segs = segment(&score, hop, 80.0);
        assert_eq!(
            segs,
            vec![
                Segment { start: 0.0, end: 20.0, kind: Kind::Speech },
                Segment { start: 20.0, end: 60.0, kind: Kind::Music },
                Segment { start: 60.0, end: 80.0, kind: Kind::Speech },
            ]
        );
    }
}
