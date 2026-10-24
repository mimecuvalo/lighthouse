<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Lighthouse icon" width="128" height="128">
</p>

<h1 align="center">Lighthouse</h1>

<p align="center">A macOS player for NPR Music podcasts that skips the talk and labels the songs.</p>

---

Lighthouse plays the [NPR Music podcast feed](https://feeds.npr.org/510019/podcast.xml): _All Songs Considered_, _New Music Friday_ and _Alt.Latino_. It's built for one job: hearing the new music and finding things you like. Each episode is analyzed on your machine to find where the music is. The scrubber then shows each song's name at the point where it starts, much like comments on a SoundCloud track.

## Features

- **Skip talk.** When a song ends and the hosts start talking, playback jumps to the next piece of music. If you rewind into the conversation on purpose, it stays put.
- **Labeled scrubber.** The waveform tints music sections and puts each artist and title where the song begins. Positions that had to be guessed are shown in italics with dashed markers.
- **Song list and notes.** Every episode lists its songs, and you can click one to jump to it. The episode notes are there too, open by default for _New Music Friday_, and the timestamps in them can be clicked.
- **Podcasts-style controls.** Skip back 15 seconds or ahead 30, or jump to the previous or next song.
- **Media keys.** F7 / F8 / F9 work with the app in the background. A setting switches F7 / F9 between 15/30-second skips and previous/next song.
- **Played tracking.** Pressing Next on the last song marks the episode played. You can also right-click an episode to mark it played or unplayed. Played episodes start over from the top when reopened, and their downloads are deleted once you move on.
- **Filters.** Filter by show and by All / Unplayed / Played / Downloaded, with counts for unplayed and downloaded episodes.
- **Resizable sidebar.** Drag its edge to resize, or double-click the edge to reset it.

### Keyboard

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Back 15 s / forward 30 s |
| <kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>Shift</kbd>+<kbd>→</kbd>, <kbd>[</kbd> / <kbd>]</kbd> | Previous / next song |
| <kbd>S</kbd> | Toggle skip talk |
| <kbd>F7</kbd> <kbd>F8</kbd> <kbd>F9</kbd> | Media keys (back, play/pause, forward) |

## How it works

When you open an episode for the first time, Lighthouse downloads it and runs four steps on the Rust side:

1. **Parse the tracklist** from the episode description (`feed.rs`). It understands the timestamped formats, such as `(03:22) Artist: "Title"` and _New Music Friday_'s `(02:23) Album No. 1` / `- Artist, 'Album'` with its lightning-round picks. It also reads untimed lists like "Featured artists and songs:".
2. **Classify the audio** (`analyze.rs`). The MP3 is decoded with [symphonia](https://github.com/pdeljanov/Symphonia) and resampled to 16 kHz. It's then run through [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet), an audio classifier, with [ONNX Runtime](https://onnxruntime.ai/). Each half-second gets a music-versus-speech score. That score is smoothed and split into music and speech sections.
3. **Align** the tracklist to those sections (`align.rs`). Timestamps in the notes mark where the hosts *introduce* a song, and inserted ads push everything later. So each song is matched to the first music section after its timestamp, allowing for a running ad offset. For untimed lists, songs are assigned in order to the longest music sections.
4. **Cache** the audio and the analysis in `~/Library/Application Support/com.mime.lighthouse/episodes/`, so reopening an episode is instant.

Ads are inserted dynamically, so they differ from one download to the next. That's why the analysis always runs on the exact file being played. The analysis takes a few seconds per episode, and everything runs locally.

Only episodes published on or after May 19, 2026 are listed.

## Development

Requires [Rust](https://rustup.rs/), Node.js, and the Xcode command-line tools.

```sh
npm install
npm run tauri dev      # run the app
npm run tauri build    # build Lighthouse.app
```

Tests and the analysis debugging tool:

```sh
cd src-tauri
cargo test                                         # feed parsing, segmentation, alignment
cargo run --bin analyze -- episode.mp3 "Gilla Band"  # print music sections and aligned songs
```

### Layout

| Path | What's there |
| --- | --- |
| `src/App.tsx` | Sidebar, episode view, keyboard shortcuts |
| `src/Scrubber.tsx` | Waveform canvas and song labels |
| `src/usePlayer.ts` | Playback, skip talk, media session |
| `src/timeline.ts` | Next/previous song and current-track helpers |
| `src-tauri/src/feed.rs` | Feed and tracklist parsing |
| `src-tauri/src/analyze.rs` | Decoding, resampling, YAMNet classification, segmentation |
| `src-tauri/src/align.rs` | Matching songs to music sections |
| `src-tauri/src/store.rs` | Downloads and the on-disk cache |
| `src-tauri/resources/` | YAMNet ONNX model and its license |

## Credits

- YAMNet model by Google, licensed under Apache 2.0 (see `src-tauri/resources/YAMNET_LICENSE`). ONNX conversion from [audiomagic/yamnet-onnx](https://huggingface.co/audiomagic/yamnet-onnx).
- Podcasts © NPR. Lighthouse is an unofficial personal player and isn't affiliated with NPR.
