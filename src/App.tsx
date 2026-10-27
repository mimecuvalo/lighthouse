import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";
import icon from "./assets/icon.png";
import { deleteEpisode, listEpisodes, onPrepareProgress, prepareEpisode } from "./api";
import { Scrubber } from "./Scrubber";
import { formatTime, musicStops, placedTracks, trackAt, trackName } from "./timeline";
import type { Episode, Prepared, PrepareProgress } from "./types";
import { BACK_SECONDS, FORWARD_SECONDS, usePlayer } from "./usePlayer";

const SHOWS = ["All", "All Songs Considered", "New Music Friday", "Alt.Latino", "NPR+"] as const;
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
  const [query, setQuery] = useState("");
  const queryRef = useRef<HTMLInputElement>(null);
  const [sidebarWidth, setSidebarWidth] = usePref<number>("sidebarWidth", SIDEBAR_DEFAULT);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const [skipTalk, setSkipTalk] = usePref<boolean>("skipTalk", true);
  const [mediaKeysJumpSongs, setMediaKeysJumpSongs] = usePref<boolean>("mediaKeysJumpSongs", true);
  // The episode on screen and the one in the player are separate, so you can browse while listening.
  const [viewing, setViewing] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const playingRef = useRef<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [playedList, setPlayedList] = usePref<string[]>("played", []);
  const played = useMemo(() => new Set(playedList), [playedList]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const markPlayed = useCallback(
    (guids: string[], value: boolean) => {
      const next = new Set(played);
      for (const g of guids) {
        if (value) next.add(g);
        else next.delete(g);
      }
      if (next.size !== played.size) setPlayedList([...next]);
    },
    [played, setPlayedList],
  );

  const setReady = (guid: string, ready: boolean) =>
    setEpisodes((eps) => eps.map((e) => (e.guid === guid ? { ...e, ready } : e)));
  const clearProgress = (guid: string) => setProgress((p) => (p?.guid === guid ? null : p));

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

  const episode = episodes.find((e) => e.guid === viewing) ?? null;
  const playingEpisode = episodes.find((e) => e.guid === playing) ?? null;
  const ready = prepared && prepared.guid === playing ? prepared : null;
  const viewingPlaying = viewing !== null && viewing === playing;

  const play = useCallback(async (guid: string) => {
    playingRef.current = guid;
    setPlaying(guid);
    setPrepared(null);
    setPrepareError(null);
    setQueue((q) => q.filter((g) => g !== guid));
    try {
      const p = await prepareEpisode(guid);
      setReady(guid, true);
      if (playingRef.current === guid) setPrepared(p);
    } catch (e) {
      if (playingRef.current === guid) setPrepareError(String(e));
    } finally {
      clearProgress(guid);
    }
  }, []);

  // Downloads from the menu run one at a time, so they don't hold up whatever you play next for long.
  useEffect(() => {
    if (downloading || queue.length === 0) return;
    const [guid, ...rest] = queue;
    setQueue(rest);
    setDownloading(guid);
    prepareEpisode(guid)
      .then(() => setReady(guid, true))
      .catch(() => setFailed((f) => new Set(f).add(guid)))
      .finally(() => {
        clearProgress(guid);
        setDownloading(null);
      });
  }, [queue, downloading]);

  const download = (guids: string[]) => {
    setFailed((f) => new Set([...f].filter((g) => !guids.includes(g))));
    setQueue((q) => [...q, ...guids.filter((g) => !q.includes(g))]);
  };

  const remove = async (guid: string) => {
    await deleteEpisode(guid);
    setReady(guid, false);
    if (guid === playing) {
      playingRef.current = null;
      setPlaying(null);
      setPrepared(null);
    }
  };

  // Played episodes don't keep their downloads. The playing one waits until you move on, so it stays playable.
  const removing = useRef(new Set<string>());
  useEffect(() => {
    for (const e of episodes) {
      if (!e.ready || !played.has(e.guid) || e.guid === playing || removing.current.has(e.guid)) continue;
      removing.current.add(e.guid);
      deleteEpisode(e.guid)
        .then(() => setReady(e.guid, false))
        .catch(() => {})
        .finally(() => removing.current.delete(e.guid));
    }
  }, [episodes, played, playing]);

  const needle = query.trim().toLowerCase();
  const inShow = episodes.filter(
    (e) =>
      (show === "All" || e.show === show) &&
      (!needle || [e.title, ...e.tracklist.map((t) => t.label)].some((s) => s.toLowerCase().includes(needle))),
  );
  const unplayedCount = inShow.filter((e) => !played.has(e.guid)).length;
  const downloadedCount = inShow.filter((e) => e.ready).length;
  const visible = inShow.filter((e) => {
    if (playedFilter === "Unplayed") return !played.has(e.guid);
    if (playedFilter === "Played") return played.has(e.guid);
    if (playedFilter === "Downloaded") return e.ready;
    return true;
  });
  const selected = visible.filter((e) => selection.has(e.guid));

  // Keep going down the list (older); at the bottom, the listener is going newest-last, so go up instead.
  const advance = (finished: string) => {
    const list = visible.some((e) => e.guid === finished) ? visible : episodes;
    const i = list.findIndex((e) => e.guid === finished);
    const unplayed = (e: Episode) => e.guid !== finished && !played.has(e.guid);
    const next = list.slice(i + 1).find(unplayed) ?? list.slice(0, Math.max(0, i)).reverse().find(unplayed);
    markPlayed([finished], true);
    if (!next) return;
    if (viewing === finished) {
      setViewing(next.guid);
      setSelection(new Set([next.guid]));
      setAnchor(next.guid);
    }
    void play(next.guid);
  };

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
    nowPlaying:
      playingEpisode && ready
        ? { title: nowTitle ?? playingEpisode.title, album: playingEpisode.title, artwork: playingEpisode.image }
        : null,
    played: ready ? played.has(ready.guid) : false,
    onFinish: () => ready && advance(ready.guid),
  });
  const current = trackAt(tracks, player.time);
  const currentName = current ? trackName(current) : null;
  useEffect(() => setNowTitle(currentName), [currentName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, select");
      if (e.metaKey && e.key === "f") {
        e.preventDefault();
        queryRef.current?.focus();
        queryRef.current?.select();
        return;
      }
      if (typing) return;
      if (e.metaKey && e.key === "a") {
        e.preventDefault();
        setSelection(new Set(visible.map((ep) => ep.guid)));
        return;
      }
      if (e.key === "Escape" && selection.size > 1) {
        setSelection(new Set(viewing ? [viewing] : []));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
  }, [player.toggle, player.skip, player.nextSong, player.previousSong, skipTalk, setSkipTalk, visible, selection, viewing]);

  const view = (guid: string) => {
    setViewing(guid);
    setSelection(new Set([guid]));
    setAnchor(guid);
  };

  // Click views an episode; ⌘-click and shift-click build a selection for the context menu.
  const onEpisodeClick = (ev: React.MouseEvent, guid: string) => {
    if (ev.shiftKey && anchor) {
      const ids = visible.map((e) => e.guid);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(guid);
      if (a !== -1) {
        setSelection(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selection);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      setSelection(next);
      setAnchor(guid);
      return;
    }
    view(guid);
  };

  // Timestamps in the notes jump to the matching song's music; other links open in the browser.
  const onNotesClick = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    const ts = href.match(/^#t=([\d.]+)$/);
    if (ts) {
      if (!viewingPlaying) return;
      const t = Number(ts[1]);
      const match = tracks.find((tr) => tr.marker_time === t);
      player.seek(match ? match.start : t);
    } else if (/^https?:/.test(href)) {
      void openUrl(href);
    }
  };

  const percentFor = (guid: string) => (progress?.guid === guid ? Math.round(progress.progress * 100) : null);
  const percent = playing ? percentFor(playing) : null;
  const waitingOnOther = !ready && !prepareError && progress !== null && progress.guid !== playing;
  const preparingLabel = waitingOnOther
    ? "Waiting for another download"
    : `${progress?.stage === "analyze" ? "Finding the music" : "Downloading"}${percent !== null ? ` · ${percent}%` : ""}`;

  const badge = (e: Episode) => {
    if (e.guid === playing) return <span className="badge playing">{player.playing ? "playing" : "paused"}</span>;
    if (e.guid === downloading) {
      const pct = percentFor(e.guid);
      return <span className="badge">{pct === null ? "downloading" : `${pct}%`}</span>;
    }
    if (queue.includes(e.guid)) return <span className="badge muted">queued</span>;
    if (failed.has(e.guid)) return <span className="badge">download failed</span>;
    if (played.has(e.guid)) return <span className="badge played">played</span>;
    if (e.ready) return <span className="badge">ready</span>;
    return null;
  };

  const busy = (guid: string) => guid === playing || guid === downloading || queue.includes(guid);
  const toDownload = selected.filter((e) => !e.ready && !played.has(e.guid) && !busy(e.guid));
  const toRemove = selected.filter((e) => e.ready);
  const allPlayed = selected.length > 0 && selected.every((e) => played.has(e.guid));
  const many = (n: number) => (selected.length > 1 ? ` (${n})` : "");

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
          <h1>
            <img src={icon} alt="" />
            Lighthouse
          </h1>
          <button className="ghost" onClick={() => refresh(true)} disabled={refreshing} title="Refresh feed">
            {refreshing ? "…" : "↻"}
          </button>
        </header>
        <div className="filter">
          <input
            ref={queryRef}
            type="search"
            placeholder="Filter episodes and songs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
        </div>
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
          <p className="muted none">
            No {playedFilter === "All" ? "" : `${playedFilter.toLowerCase()} `}episodes
            {needle ? ` matching “${query.trim()}”` : ""}.
          </p>
        )}
        {listError && <p className="error">{listError}</p>}
        <ul className="episodes">
          {visible.map((e) => {
            const songs = e.tracklist.filter((t) => t.is_song).length;
            return (
              <li key={e.guid}>
                <button
                  className={`episode${selection.has(e.guid) ? " on" : ""}${played.has(e.guid) ? " played" : ""}`}
                  onClick={(ev) => onEpisodeClick(ev, e.guid)}
                  onDoubleClick={() => void play(e.guid)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    if (!selection.has(e.guid)) {
                      setSelection(new Set([e.guid]));
                      setAnchor(e.guid);
                    }
                    setMenu({ x: ev.clientX, y: ev.clientY });
                  }}
                >
                  <span className="ep-title">
                    {e.guid === playing && <span className="playing-mark">♪ </span>}
                    {e.title}
                  </span>
                  <span className="ep-meta">
                    {formatDate(e.published)} · {e.show}
                    {songs > 0 && ` · ${songs} ${songs === 1 ? "pick" : "picks"}`}
                    {badge(e)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {menu && selected.length > 0 && (
          <div className="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(ev) => ev.stopPropagation()}>
            {selected.length === 1 && (
              <button
                onClick={() => {
                  view(selected[0].guid);
                  void play(selected[0].guid);
                  setMenu(null);
                }}
              >
                Play
              </button>
            )}
            <button
              onClick={() => {
                markPlayed(
                  selected.map((e) => e.guid),
                  !allPlayed,
                );
                setMenu(null);
              }}
            >
              {allPlayed ? "Mark as unplayed" : "Mark as played"}
              {many(selected.length)}
            </button>
            {toDownload.length > 0 && (
              <button
                onClick={() => {
                  download(toDownload.map((e) => e.guid));
                  setMenu(null);
                }}
              >
                Download{many(toDownload.length)}
              </button>
            )}
            {toRemove.length > 0 && (
              <button
                onClick={() => {
                  for (const e of toRemove) void remove(e.guid);
                  setMenu(null);
                }}
              >
                Remove download{many(toRemove.length)}
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
                <div className="actions">
                  <button
                    className="primary"
                    onClick={() => (viewingPlaying && ready ? player.toggle() : void play(episode.guid))}
                    disabled={viewingPlaying && !ready && !prepareError}
                  >
                    {viewingPlaying && ready ? (player.playing ? "❚❚ Pause" : "▶ Resume") : "▶ Play"}
                  </button>
                  {episode.ready ? (
                    <button className="link" onClick={() => remove(episode.guid)}>
                      Remove download
                    </button>
                  ) : (
                    !busy(episode.guid) && (
                      <button className="link" onClick={() => download([episode.guid])}>
                        Download
                      </button>
                    )
                  )}
                </div>
              </div>
            </header>

            {viewingPlaying && prepareError && (
              <p className="error">
                {prepareError} <button onClick={() => play(episode.guid)}>Retry</button>
              </p>
            )}

            <div className="details">
              <section className="songs">
                <h3>Songs</h3>
                {viewingPlaying && ready ? (
                  <>
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
                  </>
                ) : (
                  <>
                    {episode.tracklist.length === 0 && <p className="muted">No tracklist.</p>}
                    <ol>
                      {episode.tracklist.map((t, i) => (
                        <li key={i} className={`static${t.is_song ? "" : " chapter"}`}>
                          <span className="time">{t.time === null ? "" : formatTime(t.time)}</span>
                          <span>{t.label}</span>
                          {t.album && <span className="album">{t.album}</span>}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </section>
              <details className="notes" open={episode.show === "New Music Friday"} key={episode.guid}>
                <summary>Episode notes</summary>
                <div onClick={onNotesClick} dangerouslySetInnerHTML={{ __html: episode.description_html }} />
              </details>
            </div>
          </>
        )}
      </main>

      {playingEpisode && (
        <footer className="player">
          {ready ? (
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
          ) : (
            !prepareError && (
              <div className="bar">
                <div style={{ width: `${percent ?? 0}%` }} />
              </div>
            )
          )}
          <div className="player-row">
            <button className="player-ep" onClick={() => view(playingEpisode.guid)} title="Show episode">
              {playingEpisode.image && <img src={playingEpisode.image} alt="" />}
              <span className="player-text">
                <span className="now-name">
                  {ready ? (currentName ?? (stops.length ? playingEpisode.title : "No music detected")) : playingEpisode.title}
                </span>
                <span className="player-sub">
                  {prepareError ? "Couldn't load" : ready ? (currentName ? playingEpisode.title : playingEpisode.show) : preparingLabel}
                </span>
              </span>
            </button>
            <div className="controls">
              <button onClick={() => player.skip(-BACK_SECONDS)} disabled={!ready} title="Back 15 seconds (←)">
                −{BACK_SECONDS}
              </button>
              <button onClick={player.previousSong} disabled={!ready} title="Previous song ([)">
                ⏮
              </button>
              <button className="play" onClick={player.toggle} disabled={!ready} title="Play/pause (Space)">
                {player.playing ? "❚❚" : "▶"}
              </button>
              <button onClick={player.nextSong} disabled={!ready} title="Next song (])">
                ⏭
              </button>
              <button onClick={() => player.skip(FORWARD_SECONDS)} disabled={!ready} title="Forward 30 seconds (→)">
                +{FORWARD_SECONDS}
              </button>
            </div>
            <div className="player-right">
              <label className="toggle" title="Jump over talk between songs (S)">
                <input type="checkbox" checked={skipTalk} onChange={(e) => setSkipTalk(e.target.checked)} />
                Skip talk
              </label>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
