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
    if (video.mediaKeys) {
      return;
    }

    const label = video.getAttribute("title") || video.getAttribute("aria-label") || `Видео ${index + 1}`;
    add(video.currentSrc, label);
    add(video.getAttribute("src"), label);
    video.querySelectorAll("source[src]").forEach((source) => add(source.src, label));
  });

  document.querySelectorAll("source[src]").forEach((source) => add(source.src, "Видео"));
  document.querySelectorAll("a[href]").forEach((anchor) => {
    add(anchor.href, anchor.textContent.trim() || anchor.getAttribute("title") || "Видео");
  });

  performance.getEntriesByType("resource").forEach((entry) => {
    if (entry.initiatorType === "video" || entry.initiatorType === "source") {
      add(entry.name, "Видео со страницы");
    }
  });

  return [...found.values()].slice(0, 30);
}

async function loadCandidates() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      setStatus("Откройте обычную веб-страницу с видео и нажмите значок расширения.", true);
      return;
    }

    const execution = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectVideoCandidates
    });
    const candidates = execution[0]?.result || [];

    if (candidates.length === 0) {
      setStatus("Прямые видеофайлы не найдены.");
      return;
    }

    setStatus(`Найдено: ${candidates.length}. Выберите файл для скачивания.`);
    candidates.forEach(addCandidateToList);
  } catch (error) {
    setStatus(`Не удалось проверить страницу: ${error.message}`, true);
  }
}

loadCandidates();
