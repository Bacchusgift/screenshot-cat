export type Kind = "image" | "gif" | "video";
export interface Entry {
  id: string;
  kind: Kind;
  name: string;
  createdAt: number;
  width: number;
  height: number;
  duration: number;
  data?: string;
}
export interface Settings {
  fps: number;
  countdown: number;
  encoder: string;
}
export interface Init {
  screenPermission: boolean;
  entries: Entry[];
  settings: Settings;
  library: string;
  platform: string;
  shortcuts: { key: string; label: string; registered: boolean }[];
  ffmpeg: boolean;
  pins: string[];
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Selection {
  mode: Kind;
  image: string;
  width: number;
  height: number;
  scale: number;
  rect?: Rect;
  windows?: Rect[];
}
