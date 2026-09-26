// In-memory Google Drive v3 covering exactly the calls sync-core.js makes, driven through the
// mocked `gdrive_api` invoke. hooks.onDownload(file, who) can mutate state mid-sync or block.
export function makeFakeDrive(hooks) {
  const files = [];
  let n = 0;
  const now = () => new Date(Date.now() + n).toISOString();
  const handle = (who) => async (method, url, body) => {
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && method === "GET") {
      const q = u.searchParams.get("q") || "";
      const nameMatch = q.match(/name='([^']*)'/);
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
      const list = files.filter((f) => !!f.isFolder === wantFolder &&
        (!nameMatch || f.name === nameMatch[1]) && (!parents.length || parents.includes(f.parent)));
      return JSON.stringify({ files: list.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime })) });
    }
    if (u.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(body);
      const f = { id: "fo" + ++n, name: meta.name, isFolder: true, createdTime: now(), modifiedTime: now() };
      files.push(f);
      return JSON.stringify({ id: f.id });
    }
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      const chunks = body.split(/--ttb[0-9a-f]+/).map((c) => c.trim()).filter((c) => c && c !== "--");
      const meta = JSON.parse(chunks[0].slice(chunks[0].indexOf("{")));
      const content = chunks[1].slice(chunks[1].indexOf("{"), chunks[1].lastIndexOf("}") + 1);
      const f = { id: "f" + ++n, name: meta.name, parent: meta.parents[0], content, createdTime: now(), modifiedTime: now() };
      files.push(f);
      return JSON.stringify({ id: f.id, name: f.name });
    }
    const upd = u.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/);
    if (upd && method === "PATCH") {
      const f = files.find((x) => x.id === upd[1]);
      f.content = body; f.modifiedTime = now(); n++;
      return JSON.stringify({ id: f.id, name: f.name });
    }
    const dl = u.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
    if (dl && u.searchParams.get("alt") === "media") {
      const f = files.find((x) => x.id === dl[1]);
      const text = f ? f.content : "";
      if (hooks && hooks.onDownload) await hooks.onDownload(f, who);
      return text;
    }
    throw new Error("unhandled fake-drive request: " + method + " " + url);
  };
  return {
    files,
    handle,
    dated: () => files.filter((f) => /^timesheet-\d/.test(f.name)),
    deviceFile: (deviceId) => files.find((f) => f.name === `device-${deviceId}.json`),
  };
}

// Mocked @tauri-apps/api/core invoke for one device talking to `drive`.
export function fakeInvoke(drive, who, extra) {
  return (cmd, args) => {
    if (extra && extra[cmd]) return extra[cmd](args);
    if (cmd === "gdrive_connected") return Promise.resolve(true);
    if (cmd === "gdrive_api") return drive.handle(who)(args.method, args.url, args.body);
    if (cmd === "read_log" || cmd === "list_recovery") return Promise.resolve([]);
    return Promise.resolve();
  };
}
