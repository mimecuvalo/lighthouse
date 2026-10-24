use serde::Serialize;

use crate::analyze::{Kind, Segment};
use crate::feed::TrackEntry;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Track {
    pub label: String,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub is_song: bool,
    /// Timestamp from the description, before any ad offset.
    pub marker_time: Option<f64>,
    /// Where to jump to; `None` when we couldn't place an untimed song.
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// True when the position was guessed from list order rather than a timestamp.
    pub inferred: bool,
}

/// How far past a marker the music may start (host intros run long).
const MAX_INTRO: f64 = 120.0;
/// Intros longer than this suggest an inserted ad shifted everything.
const TYPICAL_INTRO: f64 = 60.0;
const MIN_UNANCHORED_RUN: f64 = 30.0;

/// Places tracklist entries on the episode timeline using detected music segments.
/// `ad_time` is how much longer the downloaded file is than NPR's stated duration.
pub fn align(entries: &[TrackEntry], segments: &[Segment], ad_time: f64) -> Vec<Track> {
    let ad_time = ad_time.max(0.0);
    let runs: Vec<&Segment> = segments.iter().filter(|s| s.kind == Kind::Music).collect();
    let mut tracks: Vec<Track> = entries.iter().map(track_from_entry).collect();
    let mut next_run = 0usize;
    let mut offset = 0.0f64;
    // Earliest time the next placement may start.
    let mut cursor = 0.0f64;

    let mut i = 0;
    while i < entries.len() {
        let entry = &entries[i];
        if let Some(t) = entry.time {
            let expected = t + offset;
            if !entry.is_song {
                tracks[i].start = Some(expected.max(cursor));
                cursor = cursor.max(expected);
                i += 1;
                continue;
            }
            let upper = expected + MAX_INTRO + (ad_time - offset);
            let found = (next_run..runs.len()).find(|&j| runs[j].end > expected + 5.0 && runs[j].start <= upper);
            match found {
                Some(j) => {
                    let run = runs[j];
                    // A run that began well before the marker is still the previous song.
                    let start = if run.start >= expected - 30.0 { run.start } else { expected };
                    tracks[i].start = Some(start);
                    tracks[i].end = Some(run.end);
                    offset = (start - t - TYPICAL_INTRO).max(offset).min(ad_time);
                    next_run = j + 1;
                    cursor = run.end;
                }
                None => {
                    tracks[i].start = Some(expected.max(cursor));
                    tracks[i].inferred = true;
                }
            }
            i += 1;
        } else {
            // A run of untimed songs: fill music runs between here and the next timed entry.
            let group_end = (i..entries.len()).find(|&k| entries[k].time.is_some()).unwrap_or(entries.len());
            let limit = entries[group_end..]
                .first()
                .and_then(|e| e.time)
                .map_or(f64::INFINITY, |t| t + offset);
            let anchored = i > 0;
            let min_len = if anchored { 0.0 } else { MIN_UNANCHORED_RUN };
            let candidates: Vec<usize> = (next_run..runs.len())
                .filter(|&j| runs[j].start >= cursor - 1.0 && runs[j].start < limit)
                .filter(|&j| runs[j].end - runs[j].start >= min_len)
                .collect();
            let songs: Vec<usize> = (i..group_end).filter(|&k| entries[k].is_song).collect();
            let chosen = pick_longest_in_order(&candidates, songs.len(), |j| runs[j].end - runs[j].start);
            for (&k, &j) in songs.iter().zip(&chosen) {
                tracks[k].start = Some(runs[j].start);
                tracks[k].end = Some(runs[j].end);
                tracks[k].inferred = true;
            }
            if let Some(&last) = chosen.last() {
                next_run = last + 1;
                cursor = runs[last].end;
            }
            i = group_end;
        }
    }
    tracks
}

/// Picks up to `n` of `candidates` with the largest `len`, returned in their original order.
fn pick_longest_in_order(candidates: &[usize], n: usize, len: impl Fn(usize) -> f64) -> Vec<usize> {
    let mut by_len = candidates.to_vec();
    by_len.sort_by(|&a, &b| len(b).total_cmp(&len(a)));
    by_len.truncate(n);
    by_len.sort_unstable();
    by_len
}

fn track_from_entry(e: &TrackEntry) -> Track {
    Track {
        label: e.label.clone(),
        artist: e.artist.clone(),
        title: e.title.clone(),
        album: e.album.clone(),
        is_song: e.is_song,
        marker_time: e.time,
        start: None,
        end: None,
        inferred: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn music(start: f64, end: f64) -> Segment {
        Segment { start, end, kind: Kind::Music }
    }

    /// Fills the gaps between music runs with speech, like the segmenter does.
    fn timeline(runs: &[(f64, f64)], duration: f64) -> Vec<Segment> {
        let mut out = Vec::new();
        let mut cursor = 0.0;
        for &(s, e) in runs {
            if s > cursor {
                out.push(Segment { start: cursor, end: s, kind: Kind::Speech });
            }
            out.push(music(s, e));
            cursor = e;
        }
        if cursor < duration {
            out.push(Segment { start: cursor, end: duration, kind: Kind::Speech });
        }
        out
    }

    fn timed(t: f64, name: &str, is_song: bool) -> TrackEntry {
        TrackEntry {
            time: Some(t),
            label: name.into(),
            artist: is_song.then(|| name.into()),
            title: is_song.then(|| "Song".into()),
            album: None,
            is_song,
        }
    }

    fn untimed(name: &str) -> TrackEntry {
        TrackEntry { time: None, ..timed(0.0, name, true) }
    }

    #[test]
    fn snaps_markers_to_music_after_intro_talk() {
        let entries = [timed(0.0, "Intro", false), timed(202.0, "A", true), timed(626.0, "B", true)];
        // Theme music at the top, then each song starts ~40 s after its marker.
        let segs = timeline(&[(0.0, 25.0), (245.0, 480.0), (660.0, 900.0)], 1000.0);
        let t = align(&entries, &segs, 0.0);
        assert_eq!(t[0].start, Some(0.0));
        assert_eq!((t[1].start, t[1].end), (Some(245.0), Some(480.0)));
        assert_eq!((t[2].start, t[2].end), (Some(660.0), Some(900.0)));
        assert!(t.iter().all(|t| !t.inferred));
    }

    #[test]
    fn follows_preroll_and_midroll_ads() {
        let entries = [timed(200.0, "A", true), timed(600.0, "B", true), timed(1000.0, "C", true)];
        // 60 s pre-roll shifts everything; a 30 s mid-roll before C adds more.
        let segs = timeline(&[(10.0, 50.0), (290.0, 500.0), (690.0, 900.0), (1120.0, 1300.0)], 1400.0);
        let t = align(&entries, &segs, 90.0);
        assert_eq!(t[0].start, Some(290.0));
        assert_eq!(t[1].start, Some(690.0));
        assert_eq!(t[2].start, Some(1120.0));
    }

    #[test]
    fn missing_music_falls_back_to_marker() {
        let entries = [timed(100.0, "A", true), timed(500.0, "B", true)];
        let segs = timeline(&[(130.0, 300.0)], 800.0);
        let t = align(&entries, &segs, 0.0);
        assert_eq!(t[0].start, Some(130.0));
        assert_eq!(t[1].start, Some(500.0));
        assert!(t[1].inferred);
    }

    #[test]
    fn untimed_list_takes_longest_runs_in_order() {
        let entries = [untimed("A"), untimed("B")];
        // Theme (short), A, a short sting, B.
        let segs = timeline(&[(0.0, 20.0), (100.0, 300.0), (400.0, 440.0), (500.0, 700.0)], 800.0);
        let t = align(&entries, &segs, 0.0);
        assert_eq!(t[0].start, Some(100.0));
        assert_eq!(t[1].start, Some(500.0));
        assert!(t.iter().all(|t| t.inferred));
    }

    #[test]
    fn more_songs_than_runs_leaves_rest_unplaced() {
        let entries = [untimed("A"), untimed("B"), untimed("C")];
        let segs = timeline(&[(100.0, 300.0), (400.0, 600.0)], 800.0);
        let t = align(&entries, &segs, 0.0);
        assert_eq!(t[0].start, Some(100.0));
        assert_eq!(t[1].start, Some(400.0));
        assert_eq!(t[2].start, None);
    }

    #[test]
    fn lightning_round_fills_runs_after_heading() {
        let entries = [
            timed(100.0, "Album 1", true),
            timed(400.0, "Lightning Round", false),
            untimed("X"),
            untimed("Y"),
        ];
        let segs = timeline(&[(120.0, 350.0), (420.0, 445.0), (470.0, 490.0), (560.0, 590.0)], 600.0);
        let t = align(&entries, &segs, 0.0);
        assert_eq!(t[0].start, Some(120.0));
        assert_eq!(t[1].start, Some(400.0));
        assert_eq!(t[2].start, Some(420.0));
        assert_eq!(t[3].start, Some(560.0));
    }
}
