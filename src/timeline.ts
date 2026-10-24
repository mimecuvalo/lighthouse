import type { Prepared, Segment, Track } from "./types";

export interface Stop {
  start: number;
  end: number;
}

/** Music runs are the stops for next/previous and skip-talk; named tracks label them. */
export function musicStops(segments: Segment[]): Stop[] {
  return segments.filter((s) => s.kind === "music").map(({ start, end }) => ({ start, end }));
}

export function placedTracks(p: Prepared): (Track & { start: number })[] {
  return p.tracks.filter((t): t is Track & { start: number } => t.start !== null);
}

export function segmentAt(segments: Segment[], t: number): Segment | undefined {
  return segments.find((s) => t >= s.start && t < s.end);
}

/** The labeled song that's playing (or last played) at `t`. */
export function trackAt(tracks: (Track & { start: number })[], t: number): Track | undefined {
  let current: Track | undefined;
  for (const track of tracks) {
    if (!track.is_song) continue;
    if (track.start <= t + 0.5) current = track;
    else break;
  }
  return current;
}

export function nextStop(stops: Stop[], t: number): Stop | undefined {
  return stops.find((s) => s.start > t + 1);
}

/** Restart the current stop, or go to the previous one when we're near its start. */
export function previousStop(stops: Stop[], t: number): Stop | undefined {
  const before = stops.filter((s) => s.start < t - 0.5);
  const current = before[before.length - 1];
  if (current && t - current.start > 3) return current;
  return before[before.length - 2] ?? current;
}

export function trackName(t: Track): string {
  if (t.artist && t.title) return `${t.artist} — ${t.title}`;
  return t.label;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
