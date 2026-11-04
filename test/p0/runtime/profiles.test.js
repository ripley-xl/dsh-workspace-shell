import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  DSH_BUILD_ID,
  DSH_VERSION,
  MAX_PROFILE_MANIFEST_BYTES,
  PROTOCOL_VERSION,
  REGISTRY_SCHEMA_VERSION,
} from "../../../packages/shell/ssh-remote/controller/src/constants.js";
import { instanceProfileId, sanitizeInstance, validateInstanceRecord } from "../../../packages/shell/ssh-remote/controller/src/instances.js";
import { listWebProfiles } from "../../../packages/shell/ssh-remote/controller/src/profiles.js";
import { invoke, temporaryDirectory } from "./helpers.mjs";

function record(overrides = {}) {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    instanceId: "11111111-1111-4111-8111-111111111111",
    protocolVersion: PROTOCOL_VERSION,
    dshVersion: DSH_VERSION,
    buildId: DSH_BUILD_ID,
    supervisorPid: 4242,
    hostPid: null,
    endpoint: null,
    authenticatedUrl: null,
    workspace: "/tmp",
    startedAt: new Date().toISOString(),
    createdBy: `${DSH_VERSION}-linux-x64-glibc`,
    idleTimeoutMs: 60_000,
    leaseTtlMs: 30_000,
    lastAttachAt: null,
    state: "starting",
    ...overrides,
  };
}

function profileManifest(bundles) {
  return JSON.stringify({ name: "fixture", dsh: { profile: { bundles } } });
}

test("legacy instance records without a profile ID read as the web profile", () => {
  const legacy = record();
  assert.equal(instanceProfileId(legacy), "web");
  assert.equal(validateInstanceRecord(legacy), legacy);
  assert.equal(sanitizeInstance(legacy).profileId, "web");
  assert.equal(sanitizeInstance(record({ profileId: "staging" })).profileId, "staging");
  assert.equal(validateInstanceRecord(record({ profileId: "staging" })).profileId, "staging");
});

test("instance records reject invalid profile IDs and keep the authenticated URL out of sanitized output", () => {
  for (const profileId of ["", "../escape", "with space", "a".repeat(129), 7, ".", null]) {
    assert.throws(
      () => validateInstanceRecord(record({ profileId })),
      (error) => error.code === "REMOTE_STATE_INVALID"
    );
  }
  assert.equal(instanceProfileId(record({ profileId: undefined })), "web");
  const sanitized = sanitizeInstance(record({
    profileId: "staging",
    authenticatedUrl: "http://127.0.0.1:4000/?token=super-secret-token",
  }));
  assert.equal(sanitized.profileId, "staging");
  assert.equal(JSON.stringify(sanitized).includes("super-secret-token"), false);
  assert.equal(Object.hasOwn(sanitized, "authenticatedUrl"), false);
});

test("profile listing returns only manifests that declare the Web app bundle", async (t) => {
  const home = await temporaryDirectory(t);
  const profiles = resolve(home, "profiles");
  await mkdir(profiles, { recursive: true });
  await mkdir(resolve(profiles, "web"), { recursive: true });
  await writeFile(resolve(profiles, "web", "package.json"), profileManifest(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]));
  await mkdir(resolve(profiles, "versioned"), { recursive: true });
  await writeFile(resolve(profiles, "versioned", "package.json"), profileManifest(["@deepseek-ai/dsh-web-app@0.2.1-rc.5"]));
  await mkdir(resolve(profiles, "object-bundles"), { recursive: true });
  await writeFile(resolve(profiles, "object-bundles", "package.json"),
    JSON.stringify({ dsh: { profile: { bundles: { "@deepseek-ai/dsh-web-app": { enabled: true } } } } }));
  await mkdir(resolve(profiles, "tui"), { recursive: true });
  await writeFile(resolve(profiles, "tui", "package.json"), profileManifest(["@deepseek-ai/dsh-base", "@deepseek-harness-tui/dsh-tui"]));
  await mkdir(resolve(profiles, "near-miss"), { recursive: true });
  await writeFile(resolve(profiles, "near-miss", "package.json"), profileManifest(["@deepseek-ai/dsh-web-application"]));
  await mkdir(resolve(profiles, "tui-only"), { recursive: true });
  await writeFile(resolve(profiles, "tui-only", "package.json"), JSON.stringify({ name: "no-dsh-field" }));
  await mkdir(resolve(profiles, "desktop"), { recursive: true });
  await writeFile(resolve(profiles, "desktop", "package.json"), profileManifest(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]));
  const listed = await listWebProfiles({ dshHome: home });
  assert.deepEqual(listed, { profiles: ["object-bundles", "versioned", "web"] });
});

test("profile listing skips malformed, oversized, symlinked and non-directory entries", async (t) => {
  const home = await temporaryDirectory(t);
  const profiles = resolve(home, "profiles");
  await mkdir(profiles, { recursive: true });
  await mkdir(resolve(profiles, "web"), { recursive: true });
  await writeFile(resolve(profiles, "web", "package.json"), profileManifest(["@deepseek-ai/dsh-web-app"]));
  await mkdir(resolve(profiles, "broken-json"), { recursive: true });
  await writeFile(resolve(profiles, "broken-json", "package.json"), "{\"dsh\": ");
  await mkdir(resolve(profiles, "array-manifest"), { recursive: true });
  await writeFile(resolve(profiles, "array-manifest", "package.json"), "[1,2,3]");
  await mkdir(resolve(profiles, "oversized"), { recursive: true });
  await writeFile(resolve(profiles, "oversized", "package.json"), `{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-web-app"]}},"pad":"${"x".repeat(MAX_PROFILE_MANIFEST_BYTES)}"}`);
  await mkdir(resolve(profiles, "missing-manifest"), { recursive: true });
  await writeFile(resolve(profiles, "plain-file"), profileManifest(["@deepseek-ai/dsh-web-app"]));
  await mkdir(resolve(home, "elsewhere"), { recursive: true });
  await writeFile(resolve(home, "elsewhere", "package.json"), profileManifest(["@deepseek-ai/dsh-web-app"]));
  await symlink(resolve(home, "elsewhere"), resolve(profiles, "linked"));
  await mkdir(resolve(profiles, "linked-manifest"), { recursive: true });
  await symlink(resolve(home, "elsewhere", "package.json"), resolve(profiles, "linked-manifest", "package.json"));
  const listed = await listWebProfiles({ dshHome: home });
  assert.deepEqual(listed, { profiles: ["web"] });
  const missing = await listWebProfiles({ dshHome: resolve(home, "absent-home") });
  assert.deepEqual(missing, { profiles: [] });
});

test("legacy records remain readable and appear under the web profile", async (t) => {
  const root = await temporaryDirectory(t);
  const legacy = record({ instanceId: "22222222-2222-4222-8222-222222222222", state: "stopped", hostPid: null, supervisorPid: 4242 });
  await mkdir(resolve(root, "instances", legacy.instanceId), { recursive: true });
  await writeFile(resolve(root, "instances", legacy.instanceId, "record.json"), JSON.stringify(legacy));
  const listed = await invoke(["list", "--root", root, "--profile", "web"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.response.result.instances.map((entry) => entry.instance.profileId), ["web"]);
  const other = await invoke(["list", "--root", root, "--profile", "staging"]);
  assert.deepEqual(other.response.result.instances, []);
  const status = await invoke(["status", "--root", root, "--instance-id", legacy.instanceId, "--profile", "web"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.response.result.instance.profileId, "web");
  const mismatch = await invoke(["status", "--root", root, "--instance-id", legacy.instanceId, "--profile", "staging"]);
  assert.equal(mismatch.response.error.code, "REMOTE_PROFILE_MISMATCH");
});

test("the profiles command reports only Web profiles from the selected DSH home", async (t) => {
  const home = await temporaryDirectory(t);
  const profiles = resolve(home, "profiles");
  await mkdir(resolve(profiles, "web"), { recursive: true });
  await writeFile(resolve(profiles, "web", "package.json"), profileManifest(["@deepseek-ai/dsh-web-app"]));
  await mkdir(resolve(profiles, "tui"), { recursive: true });
  await writeFile(resolve(profiles, "tui", "package.json"), profileManifest(["@deepseek-harness-tui/dsh-tui"]));
  const result = await invoke(["profiles", "--dsh-home", home, "--request-id", "profiles-test"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.response.ok, true);
  assert.equal(result.response.command, "profiles");
  assert.equal(result.response.requestId, "profiles-test");
  assert.deepEqual(result.response.result, { profiles: ["web"] });
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const relative = await invoke(["profiles", "--dsh-home", "relative/path"]);
  assert.equal(relative.response.error.code, "INVALID_ARGUMENT");
});
