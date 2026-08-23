import qrcode from 'qrcode-generator';

/** Renders `data` as a QR code image data URL — fully client-side, no network call. */
export function qrCodeDataUrl(data: string, cellSize = 6, margin = 2): string {
  const qr = qrcode(0, 'M');
  qr.addData(data);
  qr.make();
  return qr.createDataURL(cellSize, margin);
}
