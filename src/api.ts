import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Episode, Prepared, PrepareProgress } from "./types";

export const listEpisodes = (refresh: boolean) => invoke<Episode[]>("list_episodes", { refresh });

export const prepareEpisode = (guid: string) => invoke<Prepared>("prepare_episode", { guid });

export const deleteEpisode = (guid: string) => invoke<void>("delete_episode", { guid });

export const onPrepareProgress = (cb: (p: PrepareProgress) => void) =>
  listen<PrepareProgress>("prepare-progress", (e) => cb(e.payload));
