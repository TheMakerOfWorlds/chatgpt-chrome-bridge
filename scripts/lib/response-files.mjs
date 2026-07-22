import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MIB = 1024 * 1024;

export const MAX_RESPONSE_FILES = 20;
export const MAX_RESPONSE_FILE_BYTES = 200 * MIB;
export const MAX_RESPONSE_TOTAL_BYTES = 500 * MIB;

const MIME_BY_EXTENSION = new Map([
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".odp", "application/vnd.oasis.opendocument.presentation"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".rtf", "application/rtf"],
  [".svg", "image/svg+xml"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
]);

function safeToken(value, fallback = "collection") {
  return (
    String(value || "")
      .replace(/[^a-z0-9_.-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || fallback
  );
}

function decodedBaseName(value) {
  let decoded = String(value || "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep a malformed percent-encoded name as plain text and sanitize it below.
  }
  return path.basename(decoded.replaceAll("\\", "/"));
}

export function sanitizeResponseFilename(value, fallback = "chatgpt-file") {
  const raw = decodedBaseName(value) || fallback;
  const extension = path.extname(raw).slice(0, 20);
  const stem = path
    .basename(raw, path.extname(raw))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, Math.max(1, 180 - extension.length));
  const safeExtension = extension
    .normalize("NFKC")
    .replace(/[^a-z0-9.]+/gi, "")
    .slice(0, 20);
  return `${stem || fallback}${safeExtension}`;
}

export function inferMimeType(filename, supplied = null) {
  const normalized = String(supplied || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  return MIME_BY_EXTENSION.get(path.extname(filename).toLowerCase()) ||
    normalized ||
    "application/octet-stream";
}

export function safeRemoteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^(?:blob|data|sandbox):/i.test(raw)) {
    return `${raw.split(":", 1)[0].toLowerCase()}:redacted`;
  }
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export async function prepareResponseOutputDirectory({
  stateRoot,
  collectionId,
  outputDirectory,
}) {
  const requested = outputDirectory
    ? String(outputDirectory).trim()
    : path.join(
        stateRoot,
        "response-files",
        safeToken(collectionId, `collection-${crypto.randomUUID()}`),
      );
  if (!path.isAbsolute(requested)) {
    throw new Error(
      `Response-file output_directory must be an absolute path: ${requested}`,
    );
  }
  const normalized = path.normalize(requested);
  try {
    const stat = await fs.lstat(normalized);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Response-file output_directory may not be a symbolic link: ${normalized}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`Response-file output_directory is not a directory: ${normalized}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(normalized, { recursive: true, mode: 0o700 });
  }
  return normalized;
}

async function openUniqueFile(outputDirectory, requestedName) {
  const safeName = sanitizeResponseFilename(requestedName);
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  for (let index = 0; index < 1_000; index += 1) {
    const name = index ? `${stem}-${index + 1}${extension}` : safeName;
    const target = path.join(outputDirectory, name);
    try {
      const handle = await fs.open(target, "wx", 0o600);
      return { handle, name, path: target };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not reserve a unique output name for ${safeName}.`);
}

async function writeChunksToUniqueFile({
  chunks,
  outputDirectory,
  requestedName,
  maxBytes = MAX_RESPONSE_FILE_BYTES,
}) {
  const target = await openUniqueFile(outputDirectory, requestedName);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  let position = 0;
  try {
    for await (const value of chunks) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        throw new Error(
          `${target.name} exceeded the bridge's ${Math.round(maxBytes / MIB)} MB response-file limit.`,
        );
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = await target.handle.write(
          chunk,
          offset,
          chunk.length - offset,
          position,
        );
        if (!written.bytesWritten) throw new Error(`Could not write ${target.name}.`);
        offset += written.bytesWritten;
        position += written.bytesWritten;
      }
    }
    await target.handle.sync();
    await target.handle.close();
    return {
      name: target.name,
      path: target.path,
      sizeBytes,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    await target.handle.close().catch(() => {});
    await fs.rm(target.path, { force: true }).catch(() => {});
    throw error;
  }
}

export async function savePlaywrightDownload(
  download,
  {
    outputDirectory,
    requestedName,
    mimeType = null,
    sourceUrl = null,
    discoveryMethod = "browser-download",
    maxBytes = MAX_RESPONSE_FILE_BYTES,
  },
) {
  const suggestedName = download.suggestedFilename?.() || requestedName;
  const failure = await download.failure().catch(() => null);
  if (failure) throw new Error(`ChatGPT download failed: ${failure}`);
  const stream = await download.createReadStream();
  if (!stream) throw new Error("ChatGPT exposed a download but no readable file stream.");
  const saved = await writeChunksToUniqueFile({
    chunks: stream,
    outputDirectory,
    requestedName: suggestedName || requestedName || "chatgpt-file",
    maxBytes,
  });
  return {
    ...saved,
    suggestedName: suggestedName || null,
    mimeType: inferMimeType(saved.name, mimeType),
    sourceUrl: safeRemoteUrl(sourceUrl || download.url?.()),
    discoveryMethod,
    downloadedAt: new Date().toISOString(),
  };
}

export async function saveResponseBuffer(
  buffer,
  {
    outputDirectory,
    requestedName,
    mimeType = null,
    sourceUrl = null,
    discoveryMethod = "authenticated-request",
    maxBytes = MAX_RESPONSE_FILE_BYTES,
  },
) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  async function* chunks() {
    yield body;
  }
  const saved = await writeChunksToUniqueFile({
    chunks: chunks(),
    outputDirectory,
    requestedName: requestedName || "chatgpt-file",
    maxBytes,
  });
  return {
    ...saved,
    suggestedName: requestedName || null,
    mimeType: inferMimeType(saved.name, mimeType),
    sourceUrl: safeRemoteUrl(sourceUrl),
    discoveryMethod,
    downloadedAt: new Date().toISOString(),
  };
}

export function filenameFromContentDisposition(value) {
  const header = String(value || "");
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return sanitizeResponseFilename(encoded);
  const plain = header.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ||
    header.match(/filename\s*=\s*([^;]+)/i)?.[1];
  return plain ? sanitizeResponseFilename(plain.trim()) : null;
}

export async function writeResponseFileManifest(
  outputDirectory,
  {
    collectionId,
    conversationUrl,
    files,
    errors,
    detectedCount,
    expected,
  },
) {
  const manifestName = `chatgpt-response-files-${safeToken(
    collectionId,
    "collection",
  )}-${Date.now()}.json`;
  const target = await openUniqueFile(outputDirectory, manifestName);
  const payload = {
    version: 1,
    collectionId,
    conversationUrl,
    collectedAt: new Date().toISOString(),
    expected: Boolean(expected),
    detectedCount,
    files,
    errors,
  };
  try {
    await target.handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
    });
    await target.handle.sync();
    await target.handle.close();
    return target.path;
  } catch (error) {
    await target.handle.close().catch(() => {});
    await fs.rm(target.path, { force: true }).catch(() => {});
    throw error;
  }
}
