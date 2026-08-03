export interface SeededAttachment {
  // Raw bytes kept for image attachments (within a size cap) so the turn can
  // show the image to the model's vision, not just hand it the file path.
  imageBytes?: Uint8Array;
  mimeType?: string;
  name: string;
  path: string;
  type: string;
}
