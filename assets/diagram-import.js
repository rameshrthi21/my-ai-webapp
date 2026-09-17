(() => {
  "use strict";

  const ZIP_EOCD_SIG = 0x06054b50;
  const ZIP_CD_SIG = 0x02014b50;
  const ZIP_LFH_SIG = 0x04034b50;

  function findEOCD(view) {
    const len = view.byteLength;
    const maxBack = Math.min(len, 65557);
    for (let i = len - 22; i >= len - maxBack; i--) {
      if (i < 0) break;
      if (view.getUint32(i, true) === ZIP_EOCD_SIG) return i;
    }
    throw new Error("This doesn't look like a valid .pptx/.vsdx package (no ZIP end-of-central-directory record found).");
  }

  function parseCentralDirectory(view, bytes) {
    const eocd = findEOCD(view);
    const entryCount = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < entryCount; i++) {
      const sig = view.getUint32(cdOffset, true);
      if (sig !== ZIP_CD_SIG) break;
      const method = view.getUint16(cdOffset + 10, true);
      const compressedSize = view.getUint32(cdOffset + 20, true);
      const uncompressedSize = view.getUint32(cdOffset + 24, true);
      const nameLen = view.getUint16(cdOffset + 28, true);
      const extraLen = view.getUint16(cdOffset + 30, true);
      const commentLen = view.getUint16(cdOffset + 32, true);
      const localHeaderOffset = view.getUint32(cdOffset + 42, true);
      const nameBytes = bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen);
      const name = new TextDecoder("utf-8").decode(nameBytes);
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      cdOffset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function inflateRawBytes(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function extractEntryBytes(view, bytes, entry) {
    const lhOffset = entry.localHeaderOffset;
    const sig = view.getUint32(lhOffset, true);
    if (sig !== ZIP_LFH_SIG) throw new Error("Corrupt ZIP local header for " + entry.name);
    const nameLen = view.getUint16(lhOffset + 26, true);
    const extraLen = view.getUint16(lhOffset + 28, true);
    const dataStart = lhOffset + 30 + nameLen + extraLen;
    const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return inflateRawBytes(compressed);
    throw new Error("Unsupported compression method (" + entry.method + ") for " + entry.name);
  }

  function slideNum(name) {
    const m = name.match(/slide(\d+)\.xml$/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function pageNum(name) {
    const m = name.match(/page(\d+)\.xml$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function extractTextFromPptxSlideXml(doc) {
    const nodes = doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t");
    const parts = [];
    for (const n of nodes) {
      const t = n.textContent.trim();
      if (t) parts.push(t);
    }
    return parts.join("\n");
  }

  function extractTextFromVisioPageXml(doc) {
    const nodes = doc.getElementsByTagName("Text");
    const parts = [];
    for (const n of nodes) {
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
    return parts.join("\n");
  }

  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  async function extractArchitectureTextFromOfficeFile(file) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Your browser doesn't support the decompression API this needs. Use a recent Chrome, Edge, or Firefox, or paste the diagram's text manually.");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large (${Math.round(file.size / 1024 / 1024)}MB). Please keep diagram files under 25MB.`);
    }

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const entries = parseCentralDirectory(view, bytes);
    const names = entries.map((e) => e.name);
    const isPptx = names.some((n) => n.startsWith("ppt/"));
    const isVsdx = names.some((n) => n.startsWith("visio/"));

    if (!isPptx && !isVsdx) {
      throw new Error("This doesn't look like a modern .pptx or .vsdx package. Legacy binary .ppt/.vsd formats (and other file types) aren't supported here — re-save as .pptx or .vsdx, or paste the description as text.");
    }

    let targetEntries, textExtractor, kindLabel, formatLabel;
    if (isPptx) {
      targetEntries = entries
        .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
        .sort((a, b) => slideNum(a.name) - slideNum(b.name));
      textExtractor = extractTextFromPptxSlideXml;
      kindLabel = "slide";
      formatLabel = "PowerPoint (.pptx)";
    } else {
      targetEntries = entries
        .filter((e) => /^visio\/pages\/page\d+\.xml$/.test(e.name))
        .sort((a, b) => pageNum(a.name) - pageNum(b.name));
      textExtractor = extractTextFromVisioPageXml;
      kindLabel = "page";
      formatLabel = "Visio (.vsdx)";
    }

    if (!targetEntries.length) {
      throw new Error(`No ${kindLabel}s with extractable text were found in this file.`);
    }

    const sections = [];
    for (const entry of targetEntries) {
      const raw = await extractEntryBytes(view, bytes, entry);
      const xmlText = new TextDecoder("utf-8").decode(raw);
      const doc = new DOMParser().parseFromString(xmlText, "application/xml");
      const parserError = doc.getElementsByTagName("parsererror")[0];
      if (parserError) continue;
      const text = textExtractor(doc);
      if (text.trim()) {
        sections.push(`--- ${kindLabel} ${sections.length + 1} ---\n${text.trim()}`);
      }
    }

    if (!sections.length) {
      throw new Error(`Found ${targetEntries.length} ${kindLabel}(s) but none had readable text labels. Shapes may be images/screenshots rather than labeled shapes.`);
    }

    return {
      text: sections.join("\n\n"),
      unitCount: targetEntries.length,
      kindLabel,
      formatLabel,
    };
  }

  window.DiagramImport = { extractArchitectureTextFromOfficeFile };
})();
