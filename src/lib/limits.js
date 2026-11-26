// The per-file cap on a picture or voice clip a save holds in memory (Reddit's images,
// Replika's media), so one oversized file can't exhaust the memory the save is built in.
export const MEDIA_CAP_MB = 50;
export const MAX_MEDIA_BYTES = MEDIA_CAP_MB * 1048576;

// `leket reddit`: the post's JSON (a 500-comment thread is a few MB), and how many
// images one save fetches and how much they may total on disk; past either, the rest
// keep their remote links.
export const REDDIT_JSON_CAP_MB = 64;
export const REDDIT_MAX_IMAGES = 100;
export const REDDIT_IMAGES_CAP_MB = 1024;
