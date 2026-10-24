export interface TrackEntry {
  time: number | null;
  label: string;
  artist: string | null;
  title: string | null;
  album: string | null;
  is_song: boolean;
}

export interface Episode {
  guid: string;
  title: string;
  show: string;
  published: string;
  duration: number;
  audio_url: string;
  image: string | null;
  description_html: string;
  tracklist: TrackEntry[];
  ready: boolean;
}

export interface Segment {
  start: number;
  end: number;
  kind: "music" | "speech";
}

export interface Analysis {
  version: number;
  duration: number;
  frame_hop: number;
  music_score: number[];
  peak_hop: number;
  peaks: number[];
  segments: Segment[];
}

export interface Track {
  label: string;
  artist: string | null;
  title: string | null;
  album: string | null;
  is_song: boolean;
  marker_time: number | null;
  start: number | null;
  end: number | null;
  inferred: boolean;
}

export interface Prepared {
  guid: string;
  audio_path: string;
  analysis: Analysis;
  tracks: Track[];
}

export interface PrepareProgress {
  guid: string;
  stage: "download" | "analyze";
  progress: number;
}
