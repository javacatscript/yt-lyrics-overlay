/** The single place that reaches for the page's media element. */
export function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video');
}
