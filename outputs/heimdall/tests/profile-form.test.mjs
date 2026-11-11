import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgv,
  formatArgv,
  profileToForm,
  formToProfile,
  sindriProjectOf,
  isFinalExecution,
} from "../apps/web/src/features/profileForm.ts";

test("a command line is split into argv on whitespace, honouring quotes", () => {
  assert.deepEqual(parseArgv("make  lint").argv, ["make", "lint"]);
  assert.deepEqual(parseArgv("  go test ./...\t-run 'Total Sum' ").argv, [
    "go", "test", "./...", "-run", "Total Sum",
  ]);
  assert.deepEqual(parseArgv(`sh run.sh "a 'b' c" --name="x y"`).argv, [
    "sh", "run.sh", "a 'b' c", "--name=x y",
  ]);
  assert.deepEqual(parseArgv(String.raw`echo "say \"hi\" \\ \n"`).argv, ["echo", String.raw`say "hi" \ \n`]);
  assert.deepEqual(parseArgv("tool ''").argv, ["tool", ""]);
  assert.deepEqual(parseArgv("   ").argv, []);
});

test("shell syntax is not interpreted, and an open quote is an error", () => {
  assert.deepEqual(parseArgv("make test && echo $HOME | tee *.log > out").argv, [
    "make", "test", "&&", "echo", "$HOME", "|", "tee", "*.log", ">", "out",
  ]);
  assert.deepEqual(parseArgv(String.raw`dir C:\tools\x`).argv, ["dir", String.raw`C:\tools\x`]);
  assert.match(parseArgv("echo 'open").error, /unclosed ' quote/);
  assert.match(parseArgv('echo "open').error, /unclosed " quote/);
});

test("formatting an argv gives a command line that parses back to it", () => {
  for (const argv of [
    ["make", "lint"],
    ["go", "test", "-run", "Total Sum"],
    ["a'b", 'c"d', `e'f"g`, "", String.raw`back\slash`, String.raw`q"uo\te 'x'`],
  ])
    assert.deepEqual(parseArgv(formatArgv(argv)).argv, argv);
  assert.equal(formatArgv(["make", "lint"]), "make lint");
});

const stored = {
  checks: [
    { id: "lint", title: "make lint", command: ["make", "lint"], cwd: "src/app", timeoutSeconds: 900 },
    { id: "docs", command: ["sh", "check docs.sh"], required: false },
  ],
  network: "allow",
  env: { GOCACHE: "/Users/me/cache/go-build" },
  pathPrepend: ["/Users/me/shims"],
  codexSandbox: { writableRoots: ["/Users/me/cache/go-build"], networkAccess: false },
  verificationTimeoutMs: 2700000,
};

test("a stored profile survives the trip through the form unchanged", () => {
  const form = profileToForm(stored);
  assert.equal(form.checks[1].command, "sh 'check docs.sh'");
  assert.equal(form.checks[0].required, true);
  assert.equal(form.verificationMinutes, "45");
  assert.deepEqual(formToProfile(form), { profile: stored, errors: [] });
});

test("an empty form is the empty profile, and defaults stay out of the request", () => {
  assert.deepEqual(formToProfile(profileToForm({})), { profile: {}, errors: [] });
  assert.deepEqual(formToProfile(profileToForm(undefined)).profile, {});
  const form = profileToForm({ network: "deny", checks: [{ id: "t", command: ["make"], required: true }] });
  assert.deepEqual(formToProfile(form).profile, { checks: [{ id: "t", command: ["make"] }] });
});

test("the agent network switch is saved as false only when the profile already stated it", () => {
  const fresh = profileToForm({});
  assert.deepEqual(formToProfile({ ...fresh, networkAccess: true }).profile, {
    codexSandbox: { networkAccess: true },
  });
  const wasOn = profileToForm({ codexSandbox: { networkAccess: true } });
  assert.deepEqual(formToProfile({ ...wasOn, networkAccess: false }).profile, {
    codexSandbox: { networkAccess: false },
  });
});

test("the verification timeout is entered in minutes and saved in milliseconds", () => {
  const form = profileToForm({});
  assert.equal(formToProfile({ ...form, verificationMinutes: "1.5" }).profile.verificationTimeoutMs, 90000);
  assert.equal(profileToForm({ verificationTimeoutMs: 90000 }).verificationMinutes, "1.5");
  assert.equal(
    formToProfile(profileToForm({ verificationTimeoutMs: 1000 })).profile.verificationTimeoutMs,
    1000,
  );
  for (const bad of ["0", "1441", "soon"])
    assert.match(formToProfile({ ...form, verificationMinutes: bad }).errors[0], /verification timeout/);
});

test("what Sindri would refuse is reported before sending", () => {
  const base = profileToForm({});
  const check = { id: "test", title: "", command: "make test", cwd: "", timeoutSeconds: "", required: true };
  const errorsOf = (patch) => formToProfile({ ...base, ...patch }).errors.join("\n");
  assert.equal(errorsOf({ checks: [check] }), "");
  assert.match(errorsOf({ checks: [{ ...check, id: "Bad ID" }] }), /ID needs lowercase/);
  assert.match(errorsOf({ checks: [check, check] }), /used by another check/);
  assert.match(errorsOf({ checks: [{ ...check, command: " " }] }), /enter the command/);
  assert.match(errorsOf({ checks: [{ ...check, command: "sh 'x" }] }), /unclosed/);
  assert.match(errorsOf({ checks: [{ ...check, command: "sh ''" }] }), /empty quoted part/);
  assert.match(errorsOf({ checks: [{ ...check, cwd: "/abs" }] }), /stay inside the repository/);
  assert.match(errorsOf({ checks: [{ ...check, cwd: "a/../../b" }] }), /stay inside the repository/);
  assert.equal(errorsOf({ checks: [{ ...check, cwd: "a/../b" }] }), "");
  assert.match(errorsOf({ checks: [{ ...check, timeoutSeconds: "1.5" }] }), /whole number of seconds/);
  assert.match(errorsOf({ checks: [{ ...check, required: false }] }), /At least one check must be required/);
  assert.match(
    errorsOf({ checks: Array.from({ length: 21 }, (_, i) => ({ ...check, id: "c" + i })) }),
    /At most 20 checks/,
  );
  assert.match(errorsOf({ env: [{ name: "1BAD", value: "x" }] }), /names use letters/);
  assert.match(errorsOf({ env: [{ name: "GIT_DIR", value: "x" }] }), /cannot be set from a profile/);
  assert.match(errorsOf({ env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }), /listed twice/);
  assert.match(errorsOf({ env: [{ name: "A", value: "[redacted]" }] }), /hidden for display/);
  // The placeholder can stand in for any field, not only an env value.
  assert.match(
    errorsOf({ checks: [{ ...check, command: 'curl -H "Authorization: [redacted]" http://localhost/health' }] }),
    /hidden for display/,
  );
  assert.equal(errorsOf({ env: [{ name: "", value: "" }] }), "");
  assert.match(errorsOf({ pathPrepend: "relative/bin" }), /PATH additions/);
  assert.match(errorsOf({ pathPrepend: "/" }), /PATH additions/);
  assert.match(errorsOf({ writableRoots: "/a:/b" }), /Agent writable directories/);
  assert.match(errorsOf({ writableRoots: "/a/../b" }), /Agent writable directories/);
  assert.deepEqual(formToProfile({ ...base, pathPrepend: " /a/bin \n\n/b/bin\n" }).profile, {
    pathPrepend: ["/a/bin", "/b/bin"],
  });
});

test("a project's Sindri record is found by ID or repository path", () => {
  const sindri = [
    { id: "sp_1", repoPath: "/repo/a" },
    { id: "sp_2", repoPath: "/repo/b" },
  ];
  assert.equal(sindriProjectOf({ id: "sp_2" }, sindri).id, "sp_2");
  assert.equal(sindriProjectOf({ id: "prj_mimir", repoPath: "/repo/a" }, sindri).id, "sp_1");
  assert.equal(sindriProjectOf({ id: "prj_mimir", repoPath: "/repo/c" }, sindri), undefined);
  assert.equal(sindriProjectOf({ id: "prj_mimir" }, [{ id: "sp_3" }]), undefined);
});

test("failed and cancelled runs are final, like verified and delivered ones", () => {
  for (const status of ["failed", "cancelled", "verified_pending_review", "delivered", "delivered_pending_merge"])
    assert.equal(isFinalExecution(status), true, status);
  for (const status of ["running", "blocked", "awaiting_approval", undefined])
    assert.equal(isFinalExecution(status), false, String(status));
});
