/**
 * Document Picture-in-Picture is not in TypeScript's DOM lib yet.
 * Spec: https://wicg.github.io/document-picture-in-picture/
 */

interface DocumentPictureInPictureOptions {
  disallowReturnToOpener?: boolean;
  height?: number;
  preferInitialWindowPlacement?: boolean;
  width?: number;
}

interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}

interface Window {
  readonly documentPictureInPicture?: DocumentPictureInPicture;
}

declare const documentPictureInPicture: DocumentPictureInPicture | undefined;
