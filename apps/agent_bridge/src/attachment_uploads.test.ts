import assert from "node:assert/strict";
import test from "node:test";
import {
  AttachmentUploadManager,
  maxAttachmentChunkBytes,
  maxMessageAttachments,
  maxPendingAttachmentUploads,
} from "./attachment_uploads.js";

test("chunked attachment uploads accept files larger than the old inline limit", () => {
  const manager = new AttachmentUploadManager();
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
  const started = manager.begin({ name: "phone-photo.jpg", mimeType: "image/jpeg", byteLength: bytes.length });

  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + maxAttachmentChunkBytes, bytes.length));
    const progress = manager.append(started.uploadId, offset, chunk.toString("base64"));
    offset += chunk.length;
    assert.equal(progress.receivedBytes, offset);
  }

  const completed = manager.complete(started.uploadId);
  const consumption = manager.consume([completed.attachmentId]);
  const attachments = consumption.attachments;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.byteLength, bytes.length);
  assert.deepEqual(Buffer.from(attachments[0]!.dataBase64, "base64"), bytes);
  consumption.commit();
  assert.throws(() => manager.consume([completed.attachmentId]), /unknown or expired/);
});

test("released attachment consumption can be retried before a successful commit", () => {
  const manager = new AttachmentUploadManager();
  const started = manager.begin({ name: "retry.txt", mimeType: "text/plain", byteLength: 5 });
  manager.append(started.uploadId, 0, Buffer.from("retry").toString("base64"));
  const completed = manager.complete(started.uploadId);

  manager.consume([completed.attachmentId]).release();
  const retry = manager.consume([completed.attachmentId]);
  assert.equal(Buffer.from(retry.attachments[0]!.dataBase64, "base64").toString(), "retry");
  retry.commit();
  assert.throws(() => manager.consume([completed.attachmentId]), /unknown or expired/);
});

test("uploads enforce sequential offsets and the 25 MiB product cap", () => {
  const manager = new AttachmentUploadManager();
  assert.throws(
    () => manager.begin({ name: "huge.bin", mimeType: "application/octet-stream", byteLength: 25 * 1024 * 1024 + 1 }),
    /25 MiB/,
  );
  const started = manager.begin({ name: "small.bin", mimeType: "application/octet-stream", byteLength: 3 });
  assert.throws(() => manager.append(started.uploadId, 1, Buffer.from("abc").toString("base64")), /offset/);
  assert.throws(() => manager.complete(started.uploadId), /incomplete/);
});

test("uploads expire and release their reserved memory budget", () => {
  let now = 1_000;
  const manager = new AttachmentUploadManager({ maxBufferedBytes: 4, now: () => now });
  manager.begin({ name: "first.bin", mimeType: "application/octet-stream", byteLength: 4 });
  assert.throws(
    () => manager.begin({ name: "second.bin", mimeType: "application/octet-stream", byteLength: 1 }),
    /capacity/,
  );

  now += 30 * 60 * 1_000 + 1;
  assert.doesNotThrow(() =>
    manager.begin({ name: "second.bin", mimeType: "application/octet-stream", byteLength: 4 }),
  );
});

test("uploads cap pending records and sanitize phone-supplied metadata", () => {
  const manager = new AttachmentUploadManager();
  assert.throws(
    () => manager.begin({ name: "camera\nroll.jpg", mimeType: "image/jpeg", byteLength: 1 }),
    /name/,
  );
  assert.throws(
    () => manager.begin({ name: "photo.jpg", mimeType: `${"a".repeat(130)}/jpeg`, byteLength: 1 }),
    /MIME/,
  );
  for (let index = 0; index < maxPendingAttachmentUploads; index += 1) {
    manager.begin({ name: `file-${index}.bin`, mimeType: "application/octet-stream", byteLength: 1 });
  }
  assert.throws(
    () => manager.begin({ name: "one-too-many.bin", mimeType: "application/octet-stream", byteLength: 1 }),
    /Too many/,
  );
});

test("a message cannot trigger an excessive attachment concatenation", () => {
  const manager = new AttachmentUploadManager({ maxMessageBytes: 4 });
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const started = manager.begin({
      name: `large-${index}.bin`,
      mimeType: "application/octet-stream",
      byteLength: 2,
    });
    manager.append(started.uploadId, 0, Buffer.alloc(2, index).toString("base64"));
    ids.push(manager.complete(started.uploadId).attachmentId);
  }
  assert.throws(() => manager.consume(ids), /50 MiB/);
});

test("a regular message accepts a screenshot set while retaining a finite count cap", () => {
  const manager = new AttachmentUploadManager();
  const ids: string[] = [];
  for (let index = 0; index <= maxMessageAttachments; index += 1) {
    const started = manager.begin({
      name: `screenshot-${index + 1}.png`,
      mimeType: "image/png",
      byteLength: 1,
    });
    manager.append(started.uploadId, 0, Buffer.from([index]).toString("base64"));
    ids.push(manager.complete(started.uploadId).attachmentId);
  }

  const accepted = manager.consume(ids.slice(0, 6));
  assert.equal(accepted.attachments.length, 6);
  accepted.release();
  assert.throws(
    () => manager.consume(ids),
    new RegExp(`attach up to ${maxMessageAttachments} files`, "i"),
  );
});
