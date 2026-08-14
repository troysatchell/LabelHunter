/**
 * The dedicated label-image box (TRO-582, Troy's direction: "make a
 * dedicated image box, use a grid"). One shared component for both
 * detail surfaces (`DetailView`, `ReviewItemDetail`) — new code, so
 * there is no legacy class split to preserve.
 *
 * Design decisions (design-taste read: trust-first product UI, quiet):
 * - A contained figure on the page's alt background, card radius — the
 *   artwork sits in a deliberate well instead of floating as a bare
 *   image against the page.
 * - `object-fit: contain` with a capped height: label photos are often
 *   tall portraits, and an uncapped image pushed the field comparison
 *   below the fold. The full image stays visible, letterboxed by the
 *   well, never cropped — a compliance reviewer must see every edge.
 * - The persisted original filename as a caption: functional record
 *   metadata for a compliance tool, not decoration.
 * - The plain `<img>` and persisted width/height decisions carry over
 *   from DetailView's original rationale (no next/image hop; the browser
 *   reserves space before the bytes arrive).
 */

export interface LabelImageFigureProps {
  image: {
    url: string;
    width: number;
    height: number;
    originalFilename: string;
  };
}

export function LabelImageFigure({ image }: LabelImageFigureProps) {
  return (
    <figure className="label-image-figure">
      <img
        className="label-image-figure__img"
        src={image.url}
        width={image.width}
        height={image.height}
        alt="The label submitted with this application"
      />
      <figcaption className="label-image-figure__caption">{image.originalFilename}</figcaption>
    </figure>
  );
}
