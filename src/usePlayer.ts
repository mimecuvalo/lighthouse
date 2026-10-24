import { useCallback, useEffect, useRef, useState } from "react";
import type { Segment } from "./types";
import { nextStop, previousStop, segmentAt, type Stop } from "./timeline";

export const BACK_SECONDS = 15;
export const FORWARD_SECONDS = 30;

export interface NowPlaying {
  title: string;
  album: string;
  artwork: string | null;
}

interface Options {
  guid: string | null;
  src: string | null;
  segments: Segment[];
  stops: Stop[];
  skipTalk: boolean;
  /** When true, F7/F9 jump between songs instead of skipping 15/30 s. */
  mediaKeysJumpSongs: boolean;
  nowPlaying: NowPlaying | null;
  /** Played episodes start over instead of resuming. */
  played: boolean;
  /** Called when Next is pressed past the last song, or the audio runs out. */
  onFinish: () => void;
}

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Positions are a convenience; ignore storage failures.
    }
  },
};

export function savedPosition(guid: string): number {
  return Number(storage.get(`pos:${guid}`)) || 0;
}

export function usePlayer({
  guid,
  src,
  segments,
  stops,
  skipTalk,
  mediaKeysJumpSongs,
  nowPlaying,
  played,
  onFinish,
}: Options) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Latest values for event handlers that outlive renders.
  const live = useRef({ segments, stops, skipTalk, guid, played, onFinish });
  live.current = { segments, stops, skipTalk, guid, played, onFinish };
  // Skip-talk only kicks in when playback *drifts* from music into talk, not when you seek into talk.
  const lastKind = useRef<Segment["kind"] | null>(null);
  const userInTalk = useRef(false);

  const seek = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.max(0, Math.min(t, audio.duration || t));
    audio.currentTime = clamped;
    setTime(clamped);
    const kind = segmentAt(live.current.segments, clamped)?.kind ?? null;
    lastKind.current = kind;
    userInTalk.current = kind === "speech";
  }, []);

  const skip = useCallback((delta: number) => {
    const audio = audioRef.current;
    if (audio) seek(audio.currentTime + delta);
  }, [seek]);

  const nextSong = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    const stop = nextStop(live.current.stops, audio.currentTime);
    if (stop) {
      seek(stop.start);
    } else {
      audio.pause();
      live.current.onFinish();
    }
  }, [seek]);

  const previousSong = useCallback(() => {
    const audio = audioRef.current;
    const stop = audio && previousStop(live.current.stops, audio.currentTime);
    seek(stop ? stop.start : 0);
  }, [seek]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  // Load a new episode, resuming where we left off (or at the first song with skip-talk on).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!src || !guid) {
      audio.removeAttribute("src");
      audio.load();
      setTime(0);
      setDuration(0);
      return;
    }
    audio.src = src;
    const resume = live.current.played ? 0 : savedPosition(guid);
    const start = resume > 0 ? resume : live.current.skipTalk ? (live.current.stops[0]?.start ?? 0) : 0;
    const onLoaded = () => {
      seek(start);
      void audio.play();
    };
    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    return () => audio.removeEventListener("loadedmetadata", onLoaded);
  }, [src, guid, seek]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let lastSaved = 0;
    const onTime = () => {
      const t = audio.currentTime;
      const { segments, stops, skipTalk, guid } = live.current;
      const kind = segmentAt(segments, t)?.kind ?? null;
      if (kind === "music") userInTalk.current = false;
      if (skipTalk && !audio.paused && lastKind.current === "music" && kind === "speech" && !userInTalk.current) {
        const stop = nextStop(stops, t);
        if (stop) {
          seek(stop.start);
          return;
        }
      }
      lastKind.current = kind;
      if (guid && Math.abs(t - lastSaved) > 5) {
        lastSaved = t;
        storage.set(`pos:${guid}`, String(t));
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      if (live.current.guid) storage.set(`pos:${live.current.guid}`, String(audio.currentTime));
    };
    const onDuration = () => setDuration(audio.duration || 0);
    const onEnded = () => live.current.onFinish();
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("ended", onEnded);
    };
  }, [seek]);

  // Smooth playhead while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 50 && audioRef.current) {
        last = now;
        setTime(audioRef.current.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Media keys (F7/F8/F9) and Control Center arrive through the Media Session API.
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    const back = mediaKeysJumpSongs ? previousSong : () => skip(-BACK_SECONDS);
    const forward = mediaKeysJumpSongs ? nextSong : () => skip(FORWARD_SECONDS);
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void audioRef.current?.play()],
      ["pause", () => audioRef.current?.pause()],
      ["previoustrack", back],
      ["nexttrack", forward],
      ["seekbackward", (d) => skip(-(d.seekOffset ?? BACK_SECONDS))],
      ["seekforward", (d) => skip(d.seekOffset ?? FORWARD_SECONDS)],
      ["seekto", (d) => d.seekTime !== undefined && seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Unsupported action in this WebKit; ignore.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [mediaKeysJumpSongs, nextSong, previousSong, seek, skip]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || !nowPlaying || typeof MediaMetadata === "undefined") return;
    session.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: "NPR Music",
      album: nowPlaying.album,
      artwork: nowPlaying.artwork ? [{ src: nowPlaying.artwork, sizes: "1400x1400", type: "image/jpeg" }] : [],
    });
  }, [nowPlaying?.title, nowPlaying?.album, nowPlaying?.artwork]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session?.setPositionState || !duration) return;
    try {
      session.setPositionState({ duration, position: Math.min(time, duration), playbackRate: 1 });
    } catch {
      // ignore
    }
  }, [Math.floor(time), duration]);

  return { audioRef, time, duration, playing, seek, skip, toggle, nextSong, previousSong };
}
