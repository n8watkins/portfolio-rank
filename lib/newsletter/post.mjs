// A post's cover for the newsletter email, as an absolute URL (the email is
// read away from the site). The same choice as lib/blog.ts coverOf and
// imageSrc: the hero slot, else the first image; our own media route unless
// the image is a remote https URL (stock photos).

/** @param {{ id: string, images: Array<{ slot: string, url?: string, alt?: string }> }} post */
export function coverImage(post, base) {
  const im = post.images.find((i) => i.slot === "hero") ?? post.images[0];
  if (!im) return null;
  const src = im.url && /^https:\/\//.test(im.url) ? im.url : `${base}/blog/media/${post.id}/${im.slot}`;
  return { src, alt: im.alt ?? "" };
}
