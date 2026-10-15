/** Receiver compatibility and PC conversion capability are independent decisions. */
export interface PlaybackStrategy {
  mode: "direct" | "remux" | "video-transcode" | "audio-transcode" | "full-transcode";
  container: "mp4" | "mpegts" | "matroska";
  targetVideoCodec?: "h264" | "mpeg2video";
  targetAudioCodec?: "aac" | "ac3";
  copyVideo: boolean;
  copyAudio: boolean;
  compatibility: "experimental" | "confirmed";
}
export type DecodeBackend = "cpu" | "cuda" | "qsv" | "d3d11va";
export const mp4DirectExperiment: Readonly<PlaybackStrategy> = {
  mode: "direct", container: "mp4", copyVideo: true, copyAudio: true, compatibility: "experimental"
};
