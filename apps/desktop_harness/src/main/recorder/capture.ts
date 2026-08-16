import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { desktopCapturer, nativeImage, screen, type NativeImage } from "electron";
import type {
  CaptureRequest,
  CapturedFrame,
  DragSummaryRequest,
  DragSummaryResult,
  Point,
  RecorderCaptureAdapter,
  RecorderDisplay,
  Rectangle,
} from "./types.js";

export class ElectronCaptureAdapter implements RecorderCaptureAdapter {
  public displays(): readonly RecorderDisplay[] {
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal,
    }));
  }

  public async capture(request: CaptureRequest): Promise<CapturedFrame> {
    const display = screen.getDisplayNearestPoint({ x: request.x, y: request.y });
    const source = await sourceForDisplay(String(display.id), request.maxFrameDimension);
    if (source === undefined || source.thumbnail.isEmpty()) throw new Error("The display could not be captured");

    const thumbnail = source.thumbnail;
    const imageSize = thumbnail.getSize();
    const localPoint = imagePoint(request, display.bounds, imageSize);
    const marked = imageWithCursor(thumbnail, localPoint);
    const crop = boundedCrop(localPoint, imageSize, request.cursorCropSize.width, request.cursorCropSize.height);
    const fullBytes = marked.image.toJPEG(82);
    const cursorBytes = marked.image.crop(crop).toJPEG(88);
    await Promise.all([
      mkdir(dirname(request.fullPath), { recursive: true }),
      mkdir(dirname(request.cursorPath), { recursive: true }),
    ]);
    await Promise.all([writeFile(request.fullPath, fullBytes), writeFile(request.cursorPath, cursorBytes)]);
    return {
      frameId: request.frameId,
      triggerEventId: request.triggerEventId,
      timestamp: request.timestamp,
      displayId: String(display.id),
      displayBounds: display.bounds,
      imageSize,
      fullPath: request.fullPath,
      cursorPath: request.cursorPath,
      fullRelativePath: `screens/full/${basename(request.fullPath)}`,
      cursorRelativePath: `screens/cursor/${basename(request.cursorPath)}`,
      cursor: {
        screen: { x: request.x, y: request.y },
        image: localPoint,
        normalized: {
          x: localPoint.x / Math.max(1, imageSize.width - 1),
          y: localPoint.y / Math.max(1, imageSize.height - 1),
        },
        embeddedInImage: marked.embedded,
      },
      bytesWritten: fullBytes.byteLength + cursorBytes.byteLength,
    };
  }

  public async createDragSummary(request: DragSummaryRequest): Promise<DragSummaryResult | undefined> {
    if (request.frames.length === 0 || request.path.length === 0) return undefined;
    const displays = uniqueRectangles(request.frames.map((frame) => frame.displayBounds));
    const pathBounds = boundingRectangle(request.path);
    const relevantDisplays = displays.filter((display) => intersects(display, pathBounds));
    if (relevantDisplays.length === 0) return undefined;
    // A drag can cross monitors (including negative coordinates). Use one
    // stable virtual-screen crop so the contact sheet keeps the entire route.
    const virtualDisplay = unionRectangles(relevantDisplays);
    const cropBounds = dragBounds(request.path, virtualDisplay, request.padding, request.minimumSize);
    const framePaths: string[] = [];
    let bytesWritten = 0;
    await mkdir(request.outputDirectory, { recursive: true });

    for (const [index, frame] of request.frames.entries()) {
      const image = nativeImage.createFromPath(frame.fullPath);
      if (image.isEmpty()) continue;
      const intersection = intersectRectangles(cropBounds, frame.displayBounds);
      if (intersection === undefined) continue;
      const localCrop = screenRectangleToImage(intersection, frame.displayBounds, image.getSize());
      const bytes = image.crop(localCrop).toJPEG(88);
      const outputPath = join(request.outputDirectory, `${request.dragId}-${String(index).padStart(3, "0")}-${basename(frame.fullPath)}`);
      await writeFile(outputPath, bytes);
      bytesWritten += bytes.byteLength;
      framePaths.push(outputPath);
    }
    return { cropBounds, framePaths, bytesWritten };
  }
}

function boundingRectangle(points: readonly Point[]): Rectangle {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(1, Math.max(...xs) - minX + 1), height: Math.max(1, Math.max(...ys) - minY + 1) };
}

function uniqueRectangles(rectangles: readonly Rectangle[]): Rectangle[] {
  return [...new Map(rectangles.map((rectangle) => [`${rectangle.x}:${rectangle.y}:${rectangle.width}:${rectangle.height}`, rectangle])).values()];
}

function unionRectangles(rectangles: readonly Rectangle[]): Rectangle {
  const left = Math.min(...rectangles.map((rectangle) => rectangle.x));
  const top = Math.min(...rectangles.map((rectangle) => rectangle.y));
  const right = Math.max(...rectangles.map((rectangle) => rectangle.x + rectangle.width));
  const bottom = Math.max(...rectangles.map((rectangle) => rectangle.y + rectangle.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
}

function intersectRectangles(left: Rectangle, right: Rectangle): Rectangle | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.width, right.x + right.width);
  const edgeY = Math.min(left.y + left.height, right.y + right.height);
  return edgeX <= x || edgeY <= y ? undefined : { x, y, width: edgeX - x, height: edgeY - y };
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

export function dragBounds(path: readonly Point[], display: Rectangle, padding: number, minimumSize: { readonly width: number; readonly height: number }): Rectangle {
  if (path.length === 0) return display;
  const xs = path.map((point) => point.x);
  const ys = path.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;
  const wantedWidth = Math.max(minimumSize.width, maxX - minX);
  const wantedHeight = Math.max(minimumSize.height, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const width = Math.min(display.width, wantedWidth);
  const height = Math.min(display.height, wantedHeight);
  return {
    x: Math.round(clamp(centerX - width / 2, display.x, display.x + display.width - width)),
    y: Math.round(clamp(centerY - height / 2, display.y, display.y + display.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function imagePoint(point: Point, display: Rectangle, imageSize: { readonly width: number; readonly height: number }): Point {
  return {
    x: Math.round(clamp(((point.x - display.x) / display.width) * imageSize.width, 0, imageSize.width - 1)),
    y: Math.round(clamp(((point.y - display.y) / display.height) * imageSize.height, 0, imageSize.height - 1)),
  };
}

function imageWithCursor(image: NativeImage, point: Point): { readonly image: NativeImage; readonly embedded: boolean } {
  const size = image.getSize();
  try {
    const bitmap = drawCursorOnBitmap(image.toBitmap({ scaleFactor: 1 }), size.width, size.height, point);
    const marked = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: 1 });
    return marked.isEmpty() ? { image, embedded: false } : { image: marked, embedded: true };
  } catch {
    return { image, embedded: false };
  }
}

/** Draw a familiar high-contrast pointer whose tip is the captured mouse point. */
export function drawCursorOnBitmap(bitmap: Buffer, width: number, height: number, point: Point): Buffer {
  const output = Buffer.from(bitmap);
  if (width < 1 || height < 1 || output.byteLength < width * height * 4) return output;
  const scale = clamp(Math.min(width, height) / 760, 1, 2);
  const shape = (points: readonly Point[]): Point[] => points.map(({ x, y }) => ({ x: point.x + x * scale, y: point.y + y * scale }));
  const outer = shape([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 5, y: 15 }, { x: 9, y: 23 }, { x: 13, y: 21 }, { x: 9, y: 13 }, { x: 17, y: 13 }]);
  const inner = shape([{ x: 2, y: 3 }, { x: 2, y: 16 }, { x: 5, y: 12 }, { x: 10, y: 20 }, { x: 11, y: 19 }, { x: 7, y: 11 }, { x: 13, y: 11 }]);
  fillBitmapPolygon(output, width, height, outer, 20);
  fillBitmapPolygon(output, width, height, inner, 246);
  return output;
}

function fillBitmapPolygon(bitmap: Buffer, width: number, height: number, points: readonly Point[], tone: number): void {
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const right = Math.min(width - 1, Math.ceil(Math.max(...points.map((point) => point.x))));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (!insidePolygon(x + 0.5, y + 0.5, points)) continue;
      const offset = (y * width + x) * 4;
      bitmap[offset] = tone;
      bitmap[offset + 1] = tone;
      bitmap[offset + 2] = tone;
      bitmap[offset + 3] = 255;
    }
  }
}

function insidePolygon(x: number, y: number, points: readonly Point[]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const a = points[current];
    const b = points[previous];
    if (a === undefined || b === undefined) continue;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
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

function screenRectangleToImage(crop: Rectangle, display: Rectangle, imageSize: { readonly width: number; readonly height: number }): Rectangle {
  const start = imagePoint(crop, display, imageSize);
  return {
    x: Math.max(0, start.x),
    y: Math.max(0, start.y),
    width: Math.min(imageSize.width - Math.max(0, start.x), Math.max(1, Math.round(crop.width / display.width * imageSize.width))),
    height: Math.min(imageSize.height - Math.max(0, start.y), Math.max(1, Math.round(crop.height / display.height * imageSize.height))),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
