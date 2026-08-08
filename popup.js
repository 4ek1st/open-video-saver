const statusElement = document.querySelector("#status");
const resultsElement = document.querySelector("#results");

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function cleanFileName(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function fileNameFromCandidate(candidate) {
  try {
    const url = new URL(candidate.url);
    const lastSegment = decodeURIComponent(url.pathname.split("/").pop() || "");
    const fromUrl = cleanFileName(lastSegment);

    if (fromUrl && /\.(mp4|webm|mov|m4v|ogv|ogg)$/i.test(fromUrl)) {
      return fromUrl;
    }
  } catch {
    // The candidate was validated on the page; fall back to its label below.
  }

  const label = cleanFileName(candidate.label || "video");
  const extension = candidate.extension || "mp4";
  return /\.[a-z0-9]{2,5}$/i.test(label) ? label : `${label}.${extension}`;
}

function addCandidateToList(candidate) {
  const item = document.createElement("li");
  item.className = "result";

  const details = document.createElement("div");
  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = fileNameFromCandidate(candidate);
  name.title = name.textContent;

  const url = document.createElement("div");
  url.className = "file-url";
  url.textContent = candidate.url;
  url.title = candidate.url;
  details.append(name, url);

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "Скачать";
  downloadButton.addEventListener("click", async () => {
    downloadButton.disabled = true;
    const filename = `Open Video Saver/${fileNameFromCandidate(candidate)}`;

    try {
      await chrome.downloads.download({
        url: candidate.url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      setStatus("Загрузка добавлена в список скачиваний браузера.");
    } catch (error) {
      setStatus(`Не удалось скачать: ${error.message}`, true);
      downloadButton.disabled = false;
    }
  });

  item.append(details, downloadButton);
  resultsElement.append(item);
}

function collectVideoCandidates() {
  const filePattern = /\.(mp4|webm|mov|m4v|ogv|ogg)(?:$|[?#])/i;
  const blockedStreamPattern = /\.(m3u8|mpd)(?:$|[?#])/i;
  const found = new Map();
  const diagnostics = {
    isEmbeddedFrame: window.top !== window,
    iframeCount: 0,
    inaccessibleIframeCount: 0,
    videoElementCount: 0,
    streamLikeVideoCount: 0,
    streamManifestCount: 0
  };

  const normalize = (rawUrl) => {
    if (!rawUrl) {
      return null;
    }

    try {
      const url = new URL(rawUrl, document.baseURI);
      if (!/^https?:$/.test(url.protocol) || blockedStreamPattern.test(url.href)) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  };

  const extensionFor = (url) => {
    const match = url.match(/\.(mp4|webm|mov|m4v|ogv|ogg)(?:$|[?#])/i);
    return match ? match[1].toLowerCase() : "mp4";
  };

  const isStreamLike = (rawUrl) => {
    if (!rawUrl) {
      return false;
    }

    try {
      const url = new URL(rawUrl, document.baseURI);
      return url.protocol === "blob:" || blockedStreamPattern.test(url.href);
    } catch {
      return rawUrl.startsWith("blob:") || blockedStreamPattern.test(rawUrl);
    }
  };

  const add = (rawUrl, label) => {
    const url = normalize(rawUrl);
    if (!url || !filePattern.test(url)) {
      return;
    }

    const previous = found.get(url);
    if (!previous || previous.label === "Видео") {
      found.set(url, {
        url,
        label: label || "Видео",
        extension: extensionFor(url)
      });
    }
  };

  document.querySelectorAll("video").forEach((video, index) => {
    diagnostics.videoElementCount += 1;
    if (video.mediaKeys) {
      diagnostics.streamLikeVideoCount += 1;
      return;
    }

    const label = video.getAttribute("title") || video.getAttribute("aria-label") || `Видео ${index + 1}`;
    const sourceUrls = [
      video.currentSrc,
      video.getAttribute("src"),
      ...[...video.querySelectorAll("source[src]")].map((source) => source.src)
    ];

    if (sourceUrls.some(isStreamLike)) {
      diagnostics.streamLikeVideoCount += 1;
    }

    sourceUrls.forEach((sourceUrl) => add(sourceUrl, label));
  });

  document.querySelectorAll("source[src]").forEach((source) => add(source.src, "Видео"));
  document.querySelectorAll("a[href]").forEach((anchor) => {
    add(anchor.href, anchor.textContent.trim() || anchor.getAttribute("title") || "Видео");
  });

  performance.getEntriesByType("resource").forEach((entry) => {
    if (blockedStreamPattern.test(entry.name)) {
      diagnostics.streamManifestCount += 1;
    }

    if (entry.initiatorType === "video" || entry.initiatorType === "source") {
      add(entry.name, "Видео со страницы");
    }
  });

  if (!diagnostics.isEmbeddedFrame) {
    document.querySelectorAll("iframe").forEach((frame) => {
      diagnostics.iframeCount += 1;
      try {
        if (!frame.contentDocument) {
          diagnostics.inaccessibleIframeCount += 1;
        }
      } catch {
        diagnostics.inaccessibleIframeCount += 1;
      }
    });
  }

  return {
    candidates: [...found.values()].slice(0, 30),
    diagnostics
  };
}

function combineFrameResults(executionResults) {
  const deduplicatedCandidates = new Map();
  const diagnostics = {
    iframeCount: 0,
    inaccessibleIframeCount: 0,
    videoElementCount: 0,
    streamLikeVideoCount: 0,
    streamManifestCount: 0,
    scannedEmbeddedFrameCount: 0
  };

  executionResults.forEach(({ result }) => {
    if (!result) {
      return;
    }

    result.candidates.forEach((candidate) => {
      const previous = deduplicatedCandidates.get(candidate.url);
      if (!previous || previous.label === "Видео") {
        deduplicatedCandidates.set(candidate.url, candidate);
      }
    });

    const frameDiagnostics = result.diagnostics;
    diagnostics.iframeCount += frameDiagnostics.iframeCount;
    diagnostics.inaccessibleIframeCount += frameDiagnostics.inaccessibleIframeCount;
    diagnostics.videoElementCount += frameDiagnostics.videoElementCount;
    diagnostics.streamLikeVideoCount += frameDiagnostics.streamLikeVideoCount;
    diagnostics.streamManifestCount += frameDiagnostics.streamManifestCount;
    diagnostics.scannedEmbeddedFrameCount += frameDiagnostics.isEmbeddedFrame ? 1 : 0;
  });

  return {
    candidates: [...deduplicatedCandidates.values()].slice(0, 30),
    diagnostics
  };
}

function noCandidateMessage(diagnostics) {
  if (diagnostics.streamLikeVideoCount > 0 || diagnostics.streamManifestCount > 0) {
    return "Видео найдено, но оно воспроизводится потоком, а открытого прямого файла нет.";
  }

  if (diagnostics.iframeCount > 0) {
    const inaccessible = diagnostics.inaccessibleIframeCount > 0
      ? " Часть встроенных плееров находится на недоступной странице."
      : "";
    return `Прямых файлов нет. Найдено встроенных плееров: ${diagnostics.iframeCount}; проверено доступных: ${diagnostics.scannedEmbeddedFrameCount}.${inaccessible}`;
  }

  if (diagnostics.videoElementCount > 0) {
    return "Видеоэлемент найден, но открытой прямой ссылки на файл нет.";
  }

  return "Прямые видеофайлы не найдены.";
}

async function loadCandidates() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      setStatus("Откройте обычную веб-страницу с видео и нажмите значок расширения.", true);
      return;
    }

    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: collectVideoCandidates
    });
    const { candidates, diagnostics } = combineFrameResults(execution);

    if (candidates.length === 0) {
      setStatus(noCandidateMessage(diagnostics));
      return;
    }

    setStatus(`Найдено: ${candidates.length}. Выберите файл для скачивания.`);
    candidates.forEach(addCandidateToList);
  } catch (error) {
    setStatus(`Не удалось проверить страницу: ${error.message}`, true);
  }
}

loadCandidates();
