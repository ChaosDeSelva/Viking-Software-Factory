const ac = (id: string, text: string) => ({ id, text, verification: "test" as const });

/**
 * Acceptance criteria of the two live hello-factory specs: the farewell feature (endpoint plus a
 * UI button tested through the gateway) and the /greet bug fix.
 */
export const FAREWELL_ACS = [
  ac(
    "AC1",
    'In services/greeter/server.test.mjs, a node:test case starts greeter() with listen(). It checks that GET /farewell?name=Ada returns status 200 and the body {"message": "Goodbye, Ada!"} (assert.deepEqual).',
  ),
  ac(
    "AC2",
    'In ui/server.test.mjs, a node:test case starts greeter(), visits() and ui({greeterUrl, visitsUrl}). It checks that GET /api/greeter/farewell?name=Ada through the UI returns {"message": "Goodbye, Ada!"}.',
  ),
  ac(
    "AC3",
    "The existing tests still pass unchanged under `npm test`: greets by name, health and 404, the page and both-service forwarding, and the unreachable 502.",
  ),
  ac(
    "AC4",
    'The page served at / contains a button labelled "Farewell" next to the Greet button. A ui test can check this by matching the page HTML for the Farewell button.',
  ),
  ac(
    "AC5",
    'Run all three parts and open http://127.0.0.1:5100. Type "Ada" and click Farewell: the message area shows "Goodbye, Ada!". Click Greet: it still shows "Hello, Ada!".',
  ),
  ac(
    "AC6",
    "package.json still declares no dependencies or devDependencies, and no new imports other than node: built-ins are added.",
  ),
];

export const GREET_FIX_ACS = [
  ac(
    "AC1",
    'GET /greet (no query string) returns status 200 and body {"message": "Hello, world!"}.',
  ),
  ac("AC2", 'GET /greet?name= returns status 200 and body {"message": "Hello, world!"}.'),
  ac(
    "AC3",
    'GET /greet with a whitespace-only name (e.g. name=%20%20%20) returns status 200 and body {"message": "Hello, world!"}.',
  ),
  ac("AC4", 'GET /greet?name=%20%20Ada%20 returns status 200 and body {"message": "Hello, Ada!"}.'),
  ac(
    "AC5",
    "The existing tests in services/greeter/server.test.mjs ('greets by name', 'answers health and 404') and ui/server.test.mjs continue to pass under `npm test`.",
  ),
  ac(
    "AC6",
    "The new tests for AC1–AC4 fail when run against the unmodified services/greeter/server.mjs.",
  ),
  ac("AC7", "package.json gains no dependencies or devDependencies."),
];
