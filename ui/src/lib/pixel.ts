/**
 * Pixel art: how many CSS pixels make one art pixel. The world is drawn on a grid
 * about 360 pixels tall; small widgets (the strip, the scope, the minimap) use a
 * finer grid so their numbers stay legible.
 */
export function pixelScale(height = window.innerHeight): number {
  return Math.max(2, Math.round(height / 360));
}

export function widgetPixelScale(height = window.innerHeight): number {
  return Math.max(2, Math.round(pixelScale(height) * 0.6));
}
