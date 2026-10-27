import { useEffect, useMemo, useRef, useState } from "react";
import type { Segment, Track } from "./types";
import { formatTime, trackName } from "./timeline";

interface Props {
  duration: number;
  time: number;
  peaks: number[];
  peakHop: number;
  segments: Segment[];
  tracks: (Track & { start: number })[];
  currentTrack: Track | undefined;
  onSeek: (t: number) => void;
}

const ROWS = 3;
const ROW_HEIGHT = 22;
const WAVE_HEIGHT = 76;
const LABEL_MAX = 220;
const LABEL_FONT = "500 12px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";

interface PlacedLabel {
  track: Track & { start: number };
  x: number;
  left: number;
  width: number;
  row: number | null;
}

/** Greedily packs labels into rows, songs first; labels that don't fit keep just their tick. */
function packLabels(tracks: (Track & { start: number })[], width: number, duration: number): PlacedLabel[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = LABEL_FONT;
  const rowEnds = Array<number>(ROWS).fill(-Infinity);
  const labels = tracks.map((track) => {
    const x = (track.start / duration) * width;
    const text = trackName(track);
    const w = Math.min(LABEL_MAX, (ctx?.measureText(text).width ?? text.length * 7) + 14);
    const left = Math.max(0, Math.min(x - 6, width - w));
    return { track, x, left, width: w, row: null as number | null };
  });
  // Songs claim rows first; chapters ("Intro", "Lightning Round") take what's left.
  for (const songs of [true, false]) {
    for (const label of labels) {
      if (label.track.is_song !== songs) continue;
      const row = rowEnds.findIndex((end) => label.left > end + 4);
      if (row === -1) continue;
      label.row = row;
      rowEnds[row] = label.left + label.width;
    }
  }
  return labels;
}

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function Scrubber({ duration, time, peaks, peakHop, segments, tracks, currentTrack, onSeek }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scheme, setScheme] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => setScheme((s) => s + 1);
    mq.addEventListener("change", onScheme);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  const labels = useMemo(
    () => (width && duration ? packLabels(tracks, width, duration) : []),
    [tracks, width, duration],
  );

  // Bars are cheap to recompute but only change with size or data.
  const bars = useMemo(() => {
    if (!width || !duration || !peaks.length) return [];
    const step = 3;
    const count = Math.floor(width / step);
    const out: { x: number; t: number; h: number }[] = [];
    for (let i = 0; i < count; i++) {
      const t0 = (i / count) * duration;
      const t1 = ((i + 1) / count) * duration;
      let peak = 0;
      for (let p = Math.floor(t0 / peakHop); p < Math.min(peaks.length, Math.ceil(t1 / peakHop)); p++) {
        peak = Math.max(peak, peaks[p]);
      }
      out.push({ x: i * step, t: t0, h: Math.max(1, Math.pow(peak, 0.8) * (WAVE_HEIGHT - 6)) });
    }
    return out;
  }, [peaks, peakHop, width, duration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = WAVE_HEIGHT * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);
    const colors = {
      band: cssVar(canvas, "--music-band"),
      played: cssVar(canvas, "--accent"),
      music: cssVar(canvas, "--wave-music"),
      speech: cssVar(canvas, "--wave-speech"),
      tick: cssVar(canvas, "--tick"),
      playhead: cssVar(canvas, "--playhead"),
      gap: cssVar(canvas, "--bg"),
    };
    if (!duration) return;
    const toX = (t: number) => (t / duration) * width;

    ctx.fillStyle = colors.band;
    for (const s of segments) {
      if (s.kind === "music") ctx.fillRect(toX(s.start), 0, Math.max(1, toX(s.end) - toX(s.start)), WAVE_HEIGHT);
    }

    let seg = 0;
    const mid = WAVE_HEIGHT / 2;
    for (const bar of bars) {
      while (seg < segments.length - 1 && segments[seg].end <= bar.t) seg++;
      const isMusic = segments[seg]?.kind === "music";
      ctx.fillStyle = bar.t < time ? colors.played : isMusic ? colors.music : colors.speech;
      ctx.globalAlpha = bar.t < time && !isMusic ? 0.55 : 1;
      ctx.fillRect(bar.x, mid - bar.h / 2, 2, bar.h);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = colors.tick;
    for (const l of labels) ctx.fillRect(Math.round(l.x), 0, 1, WAVE_HEIGHT);

    // Cut a gap around the playhead so it stands apart from the bars behind it.
    const x = Math.round(toX(time));
    ctx.fillStyle = colors.gap;
    ctx.fillRect(x - 3, 0, 6, WAVE_HEIGHT);
    ctx.fillStyle = colors.playhead;
    ctx.fillRect(x - 1, 0, 2, WAVE_HEIGHT);
    ctx.fillRect(x - 4, 0, 8, 3);
    ctx.fillRect(x - 4, WAVE_HEIGHT - 3, 8, 3);
  }, [bars, labels, segments, time, duration, width, scheme]);

  const timeAt = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  const lanes = ROWS * ROW_HEIGHT;

  return (
    <div className="scrubber" ref={wrapRef} style={{ height: lanes + WAVE_HEIGHT + 20 }}>
      <div className="lanes" style={{ height: lanes }}>
        {labels.map((l, i) => (
          <div key={i}>
            <div
              className={`stem${l.track.is_song ? "" : " chapter"}${l.track.inferred ? " inferred" : ""}`}
              style={{ left: l.x, top: l.row === null ? lanes - 6 : l.row * ROW_HEIGHT + ROW_HEIGHT - 2, bottom: 0 }}
            />
            {l.row !== null ? (
              <button
                className={`label${l.track.is_song ? "" : " chapter"}${l.track.inferred ? " inferred" : ""}${
                  l.track === currentTrack ? " current" : ""
                }`}
                style={{ left: l.left, top: l.row * ROW_HEIGHT, maxWidth: l.width }}
                title={`${trackName(l.track)}${l.track.album ? ` · ${l.track.album}` : ""} · ${formatTime(l.track.start)}${
                  l.track.inferred ? " (position guessed)" : ""
                }`}
                onClick={() => onSeek(l.track.start)}
              >
                {trackName(l.track)}
              </button>
            ) : (
              <button
                className={`dot${l.track === currentTrack ? " current" : ""}`}
                style={{ left: l.x - 4, top: lanes - 9 }}
                title={`${trackName(l.track)} · ${formatTime(l.track.start)}`}
                onClick={() => onSeek(l.track.start)}
              />
            )}
          </div>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="wave"
        style={{ width: "100%", height: WAVE_HEIGHT }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          onSeek(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          setHover(timeAt(e.clientX));
          if (dragging) onSeek(timeAt(e.clientX));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => setHover(null)}
      />
      {hover !== null && duration > 0 && (
        <div className="hover" style={{ left: (hover / duration) * width, top: lanes }}>
          <span>{formatTime(hover)}</span>
        </div>
      )}
      <div className="axis">
        <span>{formatTime(time)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
