use std::sync::LazyLock;

use chrono::{DateTime, NaiveDate, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};

pub const FEED_URL: &str = "https://feeds.npr.org/510019/podcast.xml";

/// Oldest episode we care about: "All Songs Considered: Gracie Abrams hits a wall…".
pub fn cutoff() -> DateTime<Utc> {
    NaiveDate::from_ymd_opt(2026, 5, 19)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Episode {
    pub guid: String,
    pub title: String,
    pub show: String,
    pub published: DateTime<Utc>,
    /// Duration NPR reports, before any inserted ads.
    pub duration: f64,
    pub audio_url: String,
    pub image: Option<String>,
    pub description_html: String,
    pub tracklist: Vec<TrackEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackEntry {
    /// Segment start from the description, if it had one.
    pub time: Option<f64>,
    pub label: String,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub is_song: bool,
}

pub async fn fetch_feed_xml() -> anyhow::Result<String> {
    let res = reqwest::get(FEED_URL).await?.error_for_status()?;
    Ok(res.text().await?)
}

pub fn parse_feed(xml: &str) -> Vec<Episode> {
    static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<item>(.*?)</item>").unwrap());
    let cutoff = cutoff();
    ITEM.captures_iter(xml)
        .filter_map(|c| parse_item(&c[1]))
        .filter(|e| e.published >= cutoff)
        .collect()
}

fn parse_item(item: &str) -> Option<Episode> {
    let title = tag_text(item, "title")?;
    let guid = tag_text(item, "guid")?;
    let published = DateTime::parse_from_rfc2822(&tag_text(item, "pubDate")?)
        .ok()?
        .with_timezone(&Utc);
    let duration = tag_text(item, "itunes:duration")
        .and_then(|d| parse_duration(&d))
        .unwrap_or(0.0);
    let audio_url = tag_attr(item, "enclosure", "url")?;
    let image = tag_attr(item, "itunes:image", "href");
    let description = tag_text(item, "description").unwrap_or_default();
    Some(Episode {
        show: show_for_title(&title).to_string(),
        tracklist: parse_tracklist(&description),
        description_html: clean_description(&description),
        guid,
        title,
        published,
        duration,
        audio_url,
        image,
    })
}

fn show_for_title(title: &str) -> &'static str {
    if title.trim_end().ends_with("(NPR+)") {
        "NPR+"
    } else if title.starts_with("New Music Friday") {
        "New Music Friday"
    } else if title.starts_with("Alt.Latino") {
        "Alt.Latino"
    } else {
        "All Songs Considered"
    }
}

fn tag_text(item: &str, tag: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?s)<{tag}(?:\s[^>]*)?>(.*?)</{tag}>", tag = regex::escape(tag))).ok()?;
    let raw = re.captures(item)?.get(1)?.as_str().trim();
    Some(match raw.strip_prefix("<![CDATA[").and_then(|r| r.strip_suffix("]]>")) {
        Some(cdata) => cdata.to_string(),
        None => html_escape::decode_html_entities(raw).into_owned(),
    })
}

fn tag_attr(item: &str, tag: &str, attr: &str) -> Option<String> {
    let re = Regex::new(&format!(
        r#"<{}\s[^>]*\b{}="([^"]*)""#,
        regex::escape(tag),
        regex::escape(attr)
    ))
    .ok()?;
    let raw = re.captures(item)?.get(1)?.as_str();
    Some(html_escape::decode_html_entities(raw).into_owned())
}

fn parse_duration(s: &str) -> Option<f64> {
    let mut total = 0.0;
    for part in s.trim().split(':') {
        total = total * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(total)
}

/// Splits description HTML into trimmed, non-empty plain-text lines.
fn text_lines(html: &str) -> Vec<String> {
    static BREAK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>|</?(p|li|ul|ol|div|h\d)(\s[^>]*)?>").unwrap());
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    let with_breaks = BREAK.replace_all(html, "\n");
    let text = TAG.replace_all(&with_breaks, "");
    html_escape::decode_html_entities(&text)
        .lines()
        .map(|l| l.replace('\u{a0}', " ").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

pub fn parse_tracklist(description_html: &str) -> Vec<TrackEntry> {
    static TIMED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\((?:(\d{1,2}):)?(\d{1,2}):(\d{2})\)\s*(.+)$").unwrap());
    static LIST_HEADER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(artists and songs|(featured|mentioned).*(artists|songs)|.*(artists|songs).*(featured|mentioned)).*:$").unwrap()
    });

    let lines = text_lines(description_html);
    let mut entries: Vec<TrackEntry> = Vec::new();

    if lines.iter().any(|l| TIMED.is_match(l)) {
        // A timed list: "(03:22) Artist: “Song”" or NMF's "(02:23) Album No. 1" + "- Artist, 'Album'".
        let mut in_list = false;
        for line in &lines {
            if let Some(c) = TIMED.captures(line) {
                in_list = true;
                let h: f64 = c.get(1).map_or(0.0, |m| m.as_str().parse().unwrap());
                let m: f64 = c[2].parse().unwrap();
                let s: f64 = c[3].parse().unwrap();
                let label = c[4].trim().to_string();
                let mut entry = entry_from_line(&label);
                entry.time = Some(h * 3600.0 + m * 60.0 + s);
                entries.push(entry);
            } else if in_list && line.starts_with('-') {
                let songs = parse_song_line(line);
                if songs.is_empty() {
                    continue;
                }
                let last = entries.last_mut().unwrap();
                let mut songs = songs.into_iter();
                if !last.is_song && !is_group_heading(&last.label) {
                    // "(02:23) Album No. 1" followed by its album: merge into the timed entry.
                    let first = songs.next().unwrap();
                    last.label = format!("{} — {}", last.label, first.label);
                    last.artist = first.artist;
                    last.title = first.title;
                    last.album = first.album;
                    last.is_song = true;
                }
                // Anything else (e.g. lightning-round picks) follows as untimed entries.
                entries.extend(songs);
            }
        }
    } else if let Some(start) = lines.iter().position(|l| LIST_HEADER.is_match(l)) {
        for line in &lines[start + 1..] {
            let songs = parse_song_line(line);
            if songs.is_empty() {
                break;
            }
            entries.extend(songs);
        }
    }
    entries
}

fn is_group_heading(label: &str) -> bool {
    let l = label.to_lowercase();
    l.contains("lightning round") || l.contains("intro")
}

fn entry_from_line(label: &str) -> TrackEntry {
    match parse_song_line(label).into_iter().next() {
        Some(mut song) => {
            song.label = label.to_string();
            song
        }
        None => TrackEntry {
            time: None,
            label: label.to_string(),
            artist: None,
            title: None,
            album: None,
            is_song: false,
        },
    }
}

const OPEN_DOUBLE: &[char] = &['“', '"'];
const CLOSE_DOUBLE: &[char] = &['”', '"'];
const OPEN_SINGLE: &[char] = &['‘', '\''];
const CLOSE_SINGLE: &[char] = &['’', '\''];

/// Parses one song line into one or more songs. Returns empty when it isn't a song line.
///
/// Formats seen in the feed:
/// - `Artist: “Title”`, `Artist: “Title,” from ‘Album’`, `Artist: “Title” (single)`
/// - `Artist, "Title"` and `- Artist, 'Title'` (also `- Artist, 'A,' 'B'`)
/// - `… with “Title” by Artist`
pub fn parse_song_line(line: &str) -> Vec<TrackEntry> {
    static WITH_BY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[“\x22](.+?)[”\x22]\s+by\s+(.+)$").unwrap());
    let line = line.trim_start_matches(['-', '–', '•', ' ']).trim();

    if let Some(c) = WITH_BY.captures(line) {
        let title = c[1].trim_end_matches(',').trim().to_string();
        let artist = c[2].trim().to_string();
        return vec![song(&artist, &title, None)];
    }

    // The artist ends at the first ": " or ", " that's followed by an opening quote.
    let Some((artist, rest)) = split_artist(line) else {
        return Vec::new();
    };

    let (titles, remainder) = if rest.starts_with(OPEN_DOUBLE) {
        let inner = &rest[rest.chars().next().unwrap().len_utf8()..];
        let Some(end) = inner.find(CLOSE_DOUBLE) else {
            return Vec::new();
        };
        (vec![inner[..end].to_string()], &inner[end + inner[end..].chars().next().unwrap().len_utf8()..])
    } else {
        // Single quotes double as apostrophes ('She's the Best'), so close at the last one.
        let inner = &rest[rest.chars().next().unwrap().len_utf8()..];
        let Some(end) = inner.rfind(CLOSE_SINGLE) else {
            return Vec::new();
        };
        static MULTI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[’'],?\s+[‘']").unwrap());
        let titles = MULTI.split(&inner[..end]).map(str::to_string).collect();
        (titles, &inner[end + inner[end..].chars().next().unwrap().len_utf8()..])
    };

    let album = album_from_remainder(remainder);
    titles
        .iter()
        .map(|t| t.trim().trim_end_matches(',').trim())
        .filter(|t| !t.is_empty())
        .map(|t| song(artist, t, album.clone()))
        .collect()
}

fn split_artist(line: &str) -> Option<(&str, &str)> {
    for (i, ch) in line.char_indices() {
        if ch == ':' || ch == ',' {
            let rest = line[i + 1..].trim_start();
            if rest.starts_with(OPEN_DOUBLE) || rest.starts_with(OPEN_SINGLE) {
                let artist = line[..i].trim();
                return (!artist.is_empty()).then_some((artist, rest));
            }
        }
    }
    None
}

fn album_from_remainder(rest: &str) -> Option<String> {
    let rest = rest.trim().trim_start_matches(',').trim();
    let rest = rest.strip_prefix("from")?.trim();
    let rest = rest.trim_start_matches(OPEN_SINGLE).trim_start_matches(OPEN_DOUBLE);
    let rest = rest.trim_end_matches(CLOSE_SINGLE).trim_end_matches(CLOSE_DOUBLE);
    (!rest.is_empty()).then(|| rest.to_string())
}

fn song(artist: &str, title: &str, album: Option<String>) -> TrackEntry {
    TrackEntry {
        time: None,
        label: format!("{artist} — {title}"),
        artist: Some(artist.to_string()),
        title: Some(title.to_string()),
        album,
        is_song: true,
    }
}

/// Sanitizes description HTML for display, dropping the NPR+/privacy boilerplate,
/// and turns "(mm:ss)" timestamps into seek links.
pub fn clean_description(html: &str) -> String {
    static BOILERPLATE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)support public media with npr\+|see\s*<a[^>]*>\s*pcm\.adswizz|see pcm\.adswizz|npr privacy policy").unwrap()
    });
    static TIMESTAMP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\(((?:\d{1,2}:)?\d{1,2}:\d{2})\)").unwrap());

    let body = match BOILERPLATE.find(html) {
        Some(m) => &html[..m.start()],
        None => html,
    };
    let clean = ammonia::Builder::default()
        .link_rel(Some("noopener noreferrer"))
        .clean(body)
        .to_string();
    TIMESTAMP
        .replace_all(&clean, |c: &regex::Captures| {
            let secs = parse_duration(&c[1]).unwrap_or(0.0);
            format!(r##"<a class="ts" href="#t={secs}">({})</a>"##, &c[1])
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<Episode> {
        parse_feed(include_str!("../tests/fixtures/feed.xml"))
    }

    fn episode(title_prefix: &str) -> Episode {
        fixture()
            .into_iter()
            .find(|e| e.title.starts_with(title_prefix))
            .unwrap_or_else(|| panic!("no episode {title_prefix}"))
    }

    #[test]
    fn stops_at_cutoff() {
        let eps = fixture();
        assert!(eps.len() > 60, "got {}", eps.len());
        assert!(eps.iter().all(|e| e.published >= cutoff()));
        assert!(eps.last().unwrap().title.contains("Gracie Abrams"));
    }

    #[test]
    fn parses_item_fields() {
        let e = episode("Phoebe Bridgers, Gilla Band");
        assert_eq!(e.show, "All Songs Considered");
        assert_eq!(e.duration, 2379.0);
        assert!(e.audio_url.contains("default.mp3"));
        assert!(e.image.is_some());
    }

    #[test]
    fn npr_plus_is_its_own_show() {
        assert_eq!(episode("Over and Over: \"Crimson and Clover\"").show, "NPR+");
    }

    #[test]
    fn timed_all_songs_considered() {
        let t = episode("Phoebe Bridgers, Gilla Band").tracklist;
        assert_eq!(t.len(), 7);
        assert!(!t[0].is_song, "intro isn't a song");
        assert_eq!(t[1].time, Some(202.0));
        assert_eq!(t[1].artist.as_deref(), Some("Phoebe Bridgers"));
        assert_eq!(t[1].title.as_deref(), Some("On Video"));
        assert_eq!(t[4].title.as_deref(), Some("Carolina Murder Suicide (Avey Tare Remix)"));
        assert_eq!(t[5].artist.as_deref(), Some("serpentwithfeet"));
    }

    #[test]
    fn timed_with_by_and_talk_segments() {
        let t = episode("Elephant 6").tracklist;
        assert_eq!(t[1].title.as_deref(), Some("Black Foliage (Animation 2)"));
        assert_eq!(t[1].artist.as_deref(), Some("The Olivia Tremor Control"));
        let talk = t.iter().find(|e| e.label.starts_with("Robert Schneider")).unwrap();
        assert!(!talk.is_song);
    }

    #[test]
    fn new_music_friday_albums_and_lightning_round() {
        let t = episode("New Music Friday: The best albums out Oct. 9").tracklist;
        assert_eq!(t[0].time, Some(39.0));
        assert_eq!(t[0].artist.as_deref(), Some("Cameron Winter"));
        assert_eq!(t[0].title.as_deref(), Some("Live at Carnegie Hall"));
        assert_eq!(t[1].title.as_deref(), Some("She's the Best"));
        let lr = t.iter().position(|e| e.label.contains("Lightning Round")).unwrap();
        assert!(!t[lr].is_song);
        let picks: Vec<_> = t[lr + 1..].iter().filter_map(|e| e.artist.as_deref()).collect();
        assert_eq!(picks, ["Dawn Richard", "Margo Cilker", "Imperial Teen", "heavensouls", "Joyce Wrice"]);
        assert!(t[lr + 1..].iter().all(|e| e.time.is_none()));
    }

    #[test]
    fn untimed_featured_list() {
        let t = episode("A new canon of Halloween music").tracklist;
        assert_eq!(t.len(), 15);
        assert!(t.iter().all(|e| e.time.is_none() && e.is_song));
        assert_eq!(t[0].artist.as_deref(), Some("Phoebe Bridgers"));
        assert_eq!(t[0].title.as_deref(), Some("Killer"));
        assert_eq!(t[0].album.as_deref(), Some("Stranger in the Alps"));
        assert_eq!(t[1].title.as_deref(), Some("If I Had A Heart"));
        assert_eq!(t[1].album.as_deref(), Some("Fever Ray"));
    }

    #[test]
    fn untimed_comma_lists() {
        let t = episode("Alt.Latino: Every El Tiny song has a secret").tracklist;
        let titles: Vec<_> = t.iter().filter_map(|e| e.title.as_deref()).collect();
        assert_eq!(titles, ["No Le Regales Tu Corazón", "Monte Adentro", "Vagabundo", "Somos Más Americanos"]);

        let t = episode("Alt.Latino: Tim, The Beatles").tracklist;
        assert_eq!(t[0].artist.as_deref(), Some("The Beatles"));
        assert_eq!(t[0].title.as_deref(), Some("I Want To Hold Your Hand"));
        let jobim: Vec<_> = t
            .iter()
            .filter(|e| e.artist.as_deref() == Some("Antônio Carlos Jobim"))
            .filter_map(|e| e.title.as_deref())
            .collect();
        assert_eq!(jobim, ["Saudade Do Brasil", "O Boto"]);
        assert_eq!(t.len(), 9);
    }

    #[test]
    fn no_list() {
        assert!(episode("Alt.Latino: Cypress Hill").tracklist.is_empty());
    }

    #[test]
    fn description_is_cleaned() {
        let d = episode("New Music Friday: The best albums out Oct. 9").description_html;
        assert!(d.contains("Lightning Round"));
        assert!(!d.contains("adswizz"));
        assert!(!d.contains("Support public media"));
        assert!(d.contains(r##"<a class="ts" href="#t=39">(00:39)</a>"##));
        assert!(!d.contains("<script"));
    }
}
