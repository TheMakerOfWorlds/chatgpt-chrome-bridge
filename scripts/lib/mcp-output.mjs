import path from "node:path";
import { pathToFileURL } from "node:url";

export function responseResourceLinks(data, { serviceName = "ChatGPT" } = {}) {
  const links = [];
  const seen = new Set();
  const add = ({ filePath, name, description, mimeType, size }) => {
    if (!filePath || !path.isAbsolute(filePath) || seen.has(filePath)) return;
    seen.add(filePath);
    links.push({
      type: "resource_link",
      uri: pathToFileURL(filePath).href,
      name: name || path.basename(filePath),
      description,
      mimeType: mimeType || undefined,
      size: Number.isFinite(size) ? size : undefined,
    });
  };
  const collections = [
    data,
    data?.responseFiles,
    data?.result,
    data?.result?.responseFiles,
  ].filter(Boolean);
  for (const collection of collections) {
    for (const file of Array.isArray(collection.files) ? collection.files : []) {
      add({
        filePath: file?.path,
        name: file?.name,
        description:
          `${serviceName}-generated response file downloaded through the signed-in browser session and verified with the SHA-256 metadata in the structured result.`,
        mimeType: file?.mimeType,
        size: file?.sizeBytes,
      });
    }
    if (collection.manifestPath) {
      add({
        filePath: collection.manifestPath,
        description: `Manifest for the downloaded ${serviceName} response files.`,
        mimeType: "application/json",
      });
    }
  }
  if (data?.archive?.path) {
    add({
      filePath: data.archive.path,
      name: data.archive.name,
      description:
        "Locally prepared repository ZIP. Review its companion manifest before any upload or sharing action.",
      mimeType: data.archive.mimeType || "application/zip",
      size: data.archive.sizeBytes,
    });
  }
  if (data?.manifest?.path) {
    add({
      filePath: data.manifest.path,
      name: data.manifest.name,
      description:
        "Repository bundle manifest listing included files, excluded paths, detection reasons, limits, and archive SHA-256 metadata without detected secret values.",
      mimeType: data.manifest.mimeType || "application/json",
      size: data.manifest.sizeBytes,
    });
  }
  if (data?.screenshotPath) {
    add({
      filePath: data.screenshotPath,
      description: `Browser fail-safe screenshot of the ${serviceName} conversation.`,
      mimeType: "image/png",
    });
  }
  for (const collection of collections) {
    if (collection.inspectionScreenshotPath) {
      add({
        filePath: collection.inspectionScreenshotPath,
        description:
          "Automatic browser fail-safe screenshot captured when response-file extraction was uncertain.",
        mimeType: "image/png",
      });
    }
  }
  return links;
}
