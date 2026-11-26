// The per-file cap on a picture or voice clip a save holds in memory (Reddit's images,
// Replika's media), so one oversized file can't exhaust the memory the save is built in.
export const MEDIA_CAP_MB = 50;
export const MAX_MEDIA_BYTES = MEDIA_CAP_MB * 1048576;
