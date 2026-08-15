import { desktopCapturer, screen, type NativeImage } from "electron";
import type { Point, RecorderDisplay, Rectangle } from "../recorder/types.js";
import { normalizedPoint } from "./evidence.js";
import type { LiveCaptureFrame, LiveCaptureResult, LiveSessionCaptureAdapter } from "./types.js";

export class ElectronLiveCaptureAdapter implements LiveSessionCaptureAdapter {
  public displays(): readonly RecorderDisplay[] {
    return screen.getAllDisplays().map(toDisplay);
  }

  public displayNearest(point: Point): RecorderDisplay | undefined {
    return toDisplay(screen.getDisplayNearestPoint(point));
  }

  public async capture(point: Point, options: { readonly maxFrameDimension: number; readonly cursorCropSize: { readonly width: number; readonly height: number }; readonly jpegQuality: number }): Promise<LiveCaptureResult | undefined> {
    const display = screen.getDisplayNearestPoint(point);
    const source = await sourceForDisplay(String(display.id), options.maxFrameDimension);
    if (source === undefined || source.thumbnail.isEmpty()) return undefined;
    const thumbnail = source.thumbnail;
    const imageSize = thumbnail.getSize();
    const capturedWallTimeMs = Date.now();
    const capturedAt = new Date(capturedWallTimeMs).toISOString();
    const localPoint = imagePoint(point, display.bounds, imageSize);
    const normalized = normalizedPoint(point, display.bounds);
    const cropBounds = boundedCrop(localPoint, imageSize, options.cursorCropSize.width, options.cursorCropSize.height);
    const frameBytes = thumbnail.toJPEG(options.jpegQuality);
    const cropBytes = thumbnail.crop(cropBounds).toJPEG(Math.min(92, options.jpegQuality + 8));
    const common = {
      capturedWallTimeMs,
      capturedAt,
      displayId: String(display.id),
      displayBounds: display.bounds,
      displayScaleFactor: display.scaleFactor,
      cursor: { x: point.x, y: point.y, ...normalized },
    };
    const frame: LiveCaptureFrame = {
      ...common,
      kind: "full",
      label: "A synchronized full-display frame",
      mimeType: "image/jpeg",
      dataBase64: frameBytes.toString("base64"),
      byteLength: frameBytes.byteLength,
      width: imageSize.width,
      height: imageSize.height,
    };
    const crop: LiveCaptureFrame = {
      ...common,
      kind: "cursor",
      label: "A cursor-centred close-up",
      mimeType: "image/jpeg",
      dataBase64: cropBytes.toString("base64"),
      byteLength: cropBytes.byteLength,
      width: cropBounds.width,
      height: cropBounds.height,
    };
    return { frame, crop };
  }
}

function toDisplay(display: Electron.Display): RecorderDisplay {
  return {
    id: String(display.id),
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
  };
}

async function sourceForDisplay(displayId: string, maxDimension: number): Promise<{ thumbnail: NativeImage } | undefined> {
  const displays = screen.getAllDisplays();
  const longest = Math.max(1, ...displays.flatMap((display) => [display.size.width, display.size.height]));
  const scale = Math.min(1, maxDimension / longest);
  const thumbnailSize = {
    width: Math.max(1, Math.round(Math.max(...displays.map((display) => display.size.width)) * scale)),
    height: Math.max(1, Math.round(Math.max(...displays.map((display) => display.size.height)) * scale)),
  };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize, fetchWindowIcons: false });
  return sources.find((source) => source.display_id === displayId) ?? sources[0];
}

function imagePoint(point: Point, display: Rectangle, imageSize: { readonly width: number; readonly height: number }): Point {
  return {
    x: Math.round(((point.x - display.x) / display.width) * imageSize.width),
    y: Math.round(((point.y - display.y) / display.height) * imageSize.height),
  };
}

function boundedCrop(point: Point, imageSize: { readonly width: number; readonly height: number }, width: number, height: number): Rectangle {
  const actualWidth = Math.min(width, imageSize.width);
  const actualHeight = Math.min(height, imageSize.height);
  return {
    x: Math.round(clamp(point.x - actualWidth / 2, 0, imageSize.width - actualWidth)),
    y: Math.round(clamp(point.y - actualHeight / 2, 0, imageSize.height - actualHeight)),
    width: actualWidth,
    height: actualHeight,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
