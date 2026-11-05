// A minimal valid reddit post page for the save's tests: prepare renders the fetched
// json, so a bare Listing does not count — this shape (a t3 child with the canonical
// fields, plus a comments listing) is what a post's .json looks like, pared down.
// Spread overrides over the post, pass comment children as the second argument.
export const postPage = (post = {}, comments = []) => [
  { kind: "Listing", data: { children: [{ kind: "t3", data: {
    id: "abc123", title: "A post", subreddit: "x", author: "someone",
    score: 42, num_comments: comments.length, created_utc: 1699000000,
    permalink: "/r/x/comments/abc123/a_post/", selftext: "body text", ...post } }] } },
  { kind: "Listing", data: { children: comments } },
];
