// @ts-check
// A multipart submit sent with its progress reported: a module of its own, which only a page with
// a form that has an `on:corten:progress` handler loads, so no other page pays for it. Built into
// dist/upload.js and served as the `corten-upload` script module.

/**
 * Sends `body` as fetch would, by XMLHttpRequest, whose upload reports how much of the body is
 * sent (fetch does not): `progress` is called with each `ProgressEvent`, the last when all of it
 * is, counting the bytes of the whole request, not of a file. The answer is a `Response` read as
 * fetch's is, once all of it is in; a failure to reach the server rejects as fetch's does, and an
 * abort with the signal's reason.
 * @param {URL} url @param {string} method @param {FormData} body @param {AbortSignal} signal
 * @param {(event: ProgressEvent) => void} progress
 * @returns {Promise<Response>}
 */
export function upload(url, method, body, signal, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("corten", "action");
    xhr.responseType = "arraybuffer";
    xhr.upload.onprogress = progress;
    xhr.onload = () => {
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      // A status with no body takes none, as fetch's.
      const res = new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response, { status: xhr.status, statusText: xhr.statusText, headers });
      Object.defineProperty(res, "url", { value: xhr.responseURL });
      resolve(res);
    };
    xhr.onerror = () => reject(new TypeError("upload failed"));
    xhr.onabort = () => reject(signal.reason);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
