import { readFile } from "node:fs/promises";

const [recordPath] = process.argv.slice(2);
if (!recordPath) throw new Error("verify-http requires a private instance record path.");
const record = JSON.parse(await readFile(recordPath, "utf8"));
let url = new URL(record.authenticatedUrl);
const cookies = new Map();
let response;
for (let redirects = 0; redirects < 6; redirects += 1) {
  response = await fetch(url, {
    redirect: "manual",
    headers: cookies.size ? { cookie: [...cookies.values()].join("; ") } : {}
  });
  const setCookies = response.headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  for (const value of setCookies) {
    const pair = value.split(";", 1)[0];
    cookies.set(pair.split("=", 1)[0], pair);
  }
  if (![301, 302, 303, 307, 308].includes(response.status)) break;
  const location = response.headers.get("location");
  if (!location) break;
  url = new URL(location, url);
}
const body = await response.text();
console.log(JSON.stringify({ status: response.status, bytes: Buffer.byteLength(body), html: /<html|<!doctype html/iu.test(body) }));
if (!response.ok) process.exitCode = 1;
