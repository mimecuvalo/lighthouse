import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";
import { deleteEpisode, listEpisodes, onPrepareProgress, prepareEpisode } from "./api";
import { Scrubber } from "./Scrubber";
import { formatTime, musicStops, placedTracks, trackAt, trackName } from "./timeline";
import type { Episode, Prepared, PrepareProgress } from "./types";
import { BACK_SECONDS, FORWARD_SECONDS, usePlayer } from "./usePlayer";

const SHOWS = ["All", "All Songs Considered", "New Music Friday", "Alt.Latino"] as const;
const PLAYED_FILTERS = ["All", "Unplayed", "Played", "Downloaded"] as const;
type PlayedFilter = (typeof PLAYED_FILTERS)[number];
const SIDEBAR_DEFAULT = 320;
const clampSidebar = (w: number) => Math.round(Math.max(220, Math.min(600, w)));

function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // Preferences are a convenience; ignore storage failures.
      }
    },
    [key],
  );
  return [value, set];
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function App() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [show, setShow] = usePref<string>("show", "All");
  const [playedFilter, setPlayedFilter] = usePref<PlayedFilter>("playedFilter", "All");
  const [sidebarWidth, setSidebarWidth] = usePref<number>("sidebarWidth", SIDEBAR_DEFAULT);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const [skipTalk, setSkipTalk] = usePref<boolean>("skipTalk", true);
  const [mediaKeysJumpSongs, setMediaKeysJumpSongs] = usePref<boolean>("mediaKeysJumpSongs", true);
  const [selected, setSelected] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [playedList, setPlayedList] = usePref<string[]>("played", []);
  const played = useMemo(() => new Set(playedList), [playedList]);
  const [menu, setMenu] = useState<{ guid: string; x: number; y: number } | null>(null);

  const markPlayed = useCallback(
    (guid: string, value: boolean) => {
      if (played.has(guid) === value) return;
      setPlayedList(value ? [...playedList, guid] : playedList.filter((g) => g !== guid));
    },
    [played, playedList, setPlayedList],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      setEpisodes(await listEpisodes(force));
      setListError(null);
    } catch (e) {
      setListError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const unlisten = onPrepareProgress(setProgress);
    return () => void unlisten.then((f) => f());
  }, [refresh]);

  const episode = episodes.find((e) => e.guid === selected) ?? null;
  const ready = prepared && prepared.guid === selected ? prepared : null;

  const open = useCallback(async (guid: string) => {
    setSelected(guid);
    setPrepared(null);
    setPrepareError(null);
    setProgress(null);
    try {
      const p = await prepareEpisode(guid);
      setPrepared(p);
      setEpisodes((eps) => eps.map((e) => (e.guid === guid ? { ...e, ready: true } : e)));
    } catch (e) {
      setPrepareError(String(e));
    } finally {
      setProgress(null);
    }
  }, []);

  const remove = async (guid: string) => {
    await deleteEpisode(guid);
    setEpisodes((eps) => eps.map((e) => (e.guid === guid ? { ...e, ready: false } : e)));
    if (guid === selected) {
      setSelected(null);
      setPrepared(null);
    }
  };

  // Played episodes don't keep their downloads. The open one waits until you move on, so it stays playable.
  const removing = useRef(new Set<string>());
  useEffect(() => {
    for (const e of episodes) {
      if (!e.ready || !played.has(e.guid) || e.guid === selected || removing.current.has(e.guid)) continue;
      removing.current.add(e.guid);
      deleteEpisode(e.guid)
        .then(() => setEpisodes((eps) => eps.map((x) => (x.guid === e.guid ? { ...x, ready: false } : x))))
        .catch(() => {})
        .finally(() => removing.current.delete(e.guid));
    }
  }, [episodes, played, selected]);

  const segments = ready?.analysis.segments ?? [];
  const stops = useMemo(() => musicStops(segments), [segments]);
  const tracks = useMemo(
    () => (ready ? placedTracks(ready).sort((a, b) => a.start - b.start) : []),
    [ready],
  );
  const unplaced = ready ? ready.tracks.filter((t) => t.start === null && t.is_song) : [];

  const [nowTitle, setNowTitle] = useState<string | null>(null);
  const player = usePlayer({
    guid: ready?.guid ?? null,
    src: ready ? convertFileSrc(ready.audio_path) : null,
    segments,
    stops,
    skipTalk,
    mediaKeysJumpSongs,
    nowPlaying: episode && ready ? { title: nowTitle ?? episode.title, album: episode.title, artwork: episode.image } : null,
    played: ready ? played.has(ready.guid) : false,
    onFinish: () => ready && markPlayed(ready.guid, true),
  });
  const current = trackAt(tracks, player.time);
  const currentName = current ? trackName(current) : null;
  useEffect(() => setNowTitle(currentName), [currentName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      const actions: Record<string, () => void> = {
        " ": player.toggle,
        ArrowLeft: () => (e.shiftKey ? player.previousSong() : player.skip(-BACK_SECONDS)),
        ArrowRight: () => (e.shiftKey ? player.nextSong() : player.skip(FORWARD_SECONDS)),
        "[": player.previousSong,
        "]": player.nextSong,
        s: () => setSkipTalk(!skipTalk),
      };
      const action = actions[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player.toggle, player.skip, player.nextSong, player.previousSong, skipTalk, setSkipTalk]);

  // Timestamps in the notes jump to the matching song's music; other links open in the browser.
  const onNotesClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    const ts = href.match(/^#t=([\d.]+)$/);
    if (ts) {
      const t = Number(ts[1]);
      const match = tracks.find((tr) => tr.marker_time === t);
      player.seek(match ? match.start : t);
    } else if (/^https?:/.test(href)) {
      void openUrl(href);
    }
  };

  const inShow = episodes.filter((e) => show === "All" || e.show === show);
  const unplayedCount = inShow.filter((e) => !played.has(e.guid)).length;
  const downloadedCount = inShow.filter((e) => e.ready).length;
  const visible = inShow.filter((e) => {
    if (playedFilter === "Unplayed") return !played.has(e.guid);
    if (playedFilter === "Played") return played.has(e.guid);
    if (playedFilter === "Downloaded") return e.ready;
    return true;
  });
  const percent = progress && progress.guid === selected ? Math.round(progress.progress * 100) : null;

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <audio ref={player.audioRef} preload="auto" />
      <aside className="sidebar">
        <div
          className="resizer"
          onPointerDown={(ev) => {
            ev.currentTarget.setPointerCapture(ev.pointerId);
            resizeFrom.current = { x: ev.clientX, width: sidebarWidth };
          }}
          onPointerMove={(ev) => {
            const from = resizeFrom.current;
            if (from) setSidebarWidth(clampSidebar(from.width + ev.clientX - from.x));
          }}
          onPointerUp={() => (resizeFrom.current = null)}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        />
        <header className="sidebar-head">
          <h1>Lighthouse</h1>
          <button className="ghost" onClick={() => refresh(true)} disabled={refreshing} title="Refresh feed">
            {refreshing ? "…" : "↻"}
          </button>
        </header>
        <div className="chips">
          {SHOWS.map((s) => (
            <button key={s} className={`chip${show === s ? " on" : ""}`} onClick={() => setShow(s)}>
              {s === "All Songs Considered" ? "All Songs" : s}
            </button>
          ))}
        </div>
        <div className="chips">
          {PLAYED_FILTERS.map((f) => (
            <button
              key={f}
              className={`chip${playedFilter === f ? " on" : ""}`}
              onClick={() => setPlayedFilter(f)}
            >
              {f}
              {f === "Unplayed" && <span className="count">{unplayedCount}</span>}
              {f === "Downloaded" && downloadedCount > 0 && <span className="count">{downloadedCount}</span>}
            </button>
          ))}
        </div>
        {visible.length === 0 && episodes.length > 0 && (
          <p className="muted none">No {playedFilter === "All" ? "" : `${playedFilter.toLowerCase()} `}episodes.</p>
        )}
        {listError && <p className="error">{listError}</p>}
        <ul className="episodes">
          {visible.map((e) => {
            const songs = e.tracklist.filter((t) => t.is_song).length;
            const isPlayed = played.has(e.guid);
            return (
              <li key={e.guid}>
                <button
                  className={`episode${e.guid === selected ? " on" : ""}${isPlayed ? " played" : ""}`}
                  onClick={() => open(e.guid)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setMenu({ guid: e.guid, x: ev.clientX, y: ev.clientY });
                  }}
                >
                  <span className="ep-title">{e.title}</span>
                  <span className="ep-meta">
                    {formatDate(e.published)} · {e.show}
                    {songs > 0 && ` · ${songs} ${songs === 1 ? "pick" : "picks"}`}
                    {isPlayed ? <span className="badge played">played</span> : e.ready && <span className="badge">ready</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {menu && (
          <div
            className="menu"
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(ev) => ev.stopPropagation()}
          >
            <button
              onClick={() => {
                markPlayed(menu.guid, !played.has(menu.guid));
                setMenu(null);
              }}
            >
              {played.has(menu.guid) ? "Mark as unplayed" : "Mark as played"}
            </button>
            {episodes.find((e) => e.guid === menu.guid)?.ready && (
              <button
                onClick={() => {
                  void remove(menu.guid);
                  setMenu(null);
                }}
              >
                Remove download
              </button>
            )}
          </div>
        )}
        <footer className="prefs">
          <label>
            <span>F7 / F9</span>
            <select
              value={mediaKeysJumpSongs ? "songs" : "skip"}
              onChange={(e) => setMediaKeysJumpSongs(e.target.value === "songs")}
            >
              <option value="skip">
                −{BACK_SECONDS}s / +{FORWARD_SECONDS}s
              </option>
              <option value="songs">Previous / next song</option>
            </select>
          </label>
        </footer>
      </aside>

      <main className="main">
        {!episode ? (
          <div className="empty">
            <p>Pick an episode. Talk gets skipped, songs get labeled.</p>
            <p className="keys">
              <kbd>Space</kbd> play · <kbd>←</kbd> −15s · <kbd>→</kbd> +30s · <kbd>[</kbd> <kbd>]</kbd> songs ·{" "}
              <kbd>S</kbd> skip talk
            </p>
          </div>
        ) : (
          <>
            <header className="episode-head">
              {episode.image && <img src={episode.image} alt="" />}
              <div>
                <p className="eyebrow">
                  {episode.show} · {formatDate(episode.published)}
                </p>
                <h2>{episode.title}</h2>
                {ready && (
                  <button className="link" onClick={() => remove(episode.guid)}>
                    Remove download
                  </button>
                )}
              </div>
            </header>

            {!ready && !prepareError && (
              <div className="preparing">
                <p>
                  {progress?.stage === "analyze" ? "Finding the music" : "Downloading"}
                  {percent !== null && ` · ${percent}%`}
                </p>
                <div className="bar">
                  <div style={{ width: `${percent ?? 0}%` }} />
                </div>
              </div>
            )}
            {prepareError && (
              <p className="error">
                {prepareError} <button onClick={() => open(episode.guid)}>Retry</button>
              </p>
            )}

            {ready && (
              <>
                <Scrubber
                  duration={player.duration || ready.analysis.duration}
                  time={player.time}
                  peaks={ready.analysis.peaks}
                  peakHop={ready.analysis.peak_hop}
                  segments={segments}
                  tracks={tracks}
                  currentTrack={current}
                  onSeek={player.seek}
                />

                <div className="controls">
                  <button onClick={() => player.skip(-BACK_SECONDS)} title="Back 15 seconds (←)">
                    −{BACK_SECONDS}
                  </button>
                  <button onClick={player.previousSong} title="Previous song ([)">
                    ⏮
                  </button>
                  <button className="play" onClick={player.toggle} title="Play/pause (Space)">
                    {player.playing ? "❚❚" : "▶"}
                  </button>
                  <button onClick={player.nextSong} title="Next song (])">
                    ⏭
                  </button>
                  <button onClick={() => player.skip(FORWARD_SECONDS)} title="Forward 30 seconds (→)">
                    +{FORWARD_SECONDS}
                  </button>
                  <div className="now">
                    <span className="now-label">{current ? "Now" : ""}</span>
                    <span className="now-name">{currentName ?? (stops.length ? "" : "No music detected")}</span>
                  </div>
                  <label className="toggle" title="Jump over talk between songs (S)">
                    <input type="checkbox" checked={skipTalk} onChange={(e) => setSkipTalk(e.target.checked)} />
                    Skip talk
                  </label>
                </div>

                <div className="details">
                  <section className="songs">
                    <h3>Songs</h3>
                    {tracks.length === 0 && unplaced.length === 0 && (
                      <p className="muted">No tracklist. Use ⏭ to hop between the {stops.length} music sections.</p>
                    )}
                    <ol>
                      {tracks.map((t, i) => (
                        <li key={i} className={`${t.is_song ? "" : "chapter"}${t === current ? " current" : ""}`}>
                          <button onClick={() => player.seek(t.start)}>
                            <span className="time">{formatTime(t.start)}</span>
                            <span className={t.inferred ? "inferred" : ""}>{trackName(t)}</span>
                            {t.album && <span className="album">{t.album}</span>}
                          </button>
                        </li>
                      ))}
                      {unplaced.map((t, i) => (
                        <li key={`u${i}`} className="unplaced" title="Couldn't find where this plays">
                          <span className="time">—</span>
                          <span>{trackName(t)}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                  <details className="notes" open={episode.show === "New Music Friday"} key={episode.guid}>
                    <summary>Episode notes</summary>
                    <div onClick={onNotesClick} dangerouslySetInnerHTML={{ __html: episode.description_html }} />
                  </details>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
