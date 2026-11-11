// Self-contained browser acceptance: starts its own in-memory app (simulation, then an AWS
// fixture that makes no cloud calls) and drives the dashboard like an operator.
// `SKIDBLADNIR_BROWSER_CHANNEL=chrome` uses the installed Chrome instead of Playwright's Chromium.
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../apps/api/server.mjs';
import { Simulator } from '../packages/providers/simulator.mjs';

class Fixture extends Simulator {
  mode = 'aws';
  maxWorkers = 1;
  config = { accountId: '123456789012', region: 'us-west-2', fleetId: 'fixture-only', templates: { general: {} } };
  prepare(input) {
    return {
      id: 'aws-fixture',
      ...input,
      state: 'provisioning',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  }
  async create(input, worker) {
    return { ...worker, instanceId: 'i-fixture', state: 'running' };
  }
  async inspect(worker) {
    return worker;
  }
  async execute(worker, command) {
    return {
      commandId: 'fixture-command',
      instanceId: 'i-fixture',
      status: 'Pending',
      artifact: command.startsWith('python3'),
    };
  }
  async command(worker, record) {
    return {
      ...record,
      status: 'Success',
      exitCode: 0,
      stdout: record.artifact
        ? JSON.stringify({
            data: Buffer.from('file evidence').toString('base64'),
            bytes: 13,
            sha256: createHash('sha256').update('file evidence').digest('hex'),
          })
        : 'synthetic browser result\n',
    };
  }
}

async function noOverflowNoAxe(page) {
  // Close any focus/hover tooltip first: its portal sits outside the landmarks while open.
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(0, 0);
  await page
    .getByRole('tooltip')
    .first()
    .waitFor({ state: 'detached' })
    .catch(() => {});
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow)
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll('*')]
            .filter((x) => x.getBoundingClientRect().right > innerWidth + 1)
            .map((x) => [x.tagName, x.className, x.textContent?.slice(0, 50)]),
        ),
      );
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    const result = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(
      result.violations.map((v) => v.id),
      [],
      `axe at ${width}px: ${JSON.stringify(result.violations.map((v) => v.nodes.map((n) => n.html.slice(0, 160))))}`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function launch(page, name, project) {
  await page.getByRole('link', { name: 'Launch', exact: true }).click();
  await page.getByRole('heading', { name: 'Launch', exact: true, level: 1 }).waitFor();
  await page.getByLabel('Worker name').fill(name);
  if (project !== undefined) await page.getByLabel('Project', { exact: true }).fill(project);
}

const browser = await chromium.launch({
  headless: true,
  channel: process.env.SKIDBLADNIR_BROWSER_CHANNEL || undefined,
});
try {
  for (const aws of [false, true]) {
    const app = createApp({ provider: aws ? new Fixture() : new Simulator() });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(base);
      await page.getByRole('status').filter({ hasText: 'Live' }).first().waitFor();
      await page.getByRole('link', { name: 'Skip to content' }).waitFor({ state: 'attached' });
      await page
        .getByRole('contentinfo', { name: 'Status and global' })
        .getByText(aws ? /^AWS · us-west-2/ : 'Simulation')
        .first()
        .waitFor();
      assert.match(
        await page.getByRole('link', { name: 'Docs', exact: true }).getAttribute('href'),
        /^#\/docs\/skidbladnir-screens#worker-fleet$/,
      );
      assert.equal(await page.getByRole('link', { name: 'Setup guide' }).getAttribute('href'), '/site/guide.html');

      if (!aws) {
        await page.getByText('Your first voyage starts here.').waitFor();
        await noOverflowNoAxe(page);
        await page.getByRole('main').getByRole('button', { name: 'Launch a worker' }).last().click();
        await page.getByRole('heading', { name: 'Launch', exact: true, level: 1 }).waitFor();
        await page.getByRole('link', { name: 'Worker fleet' }).click();
      }

      await launch(page, 'Synthetic browser test', aws ? undefined : 'demo-app');
      const submit = page.getByRole('button', { name: aws ? 'Launch AWS worker' : 'Launch simulated worker' });
      if (aws) {
        assert.equal(await submit.isDisabled(), true);
        await page.getByLabel('I approve creating a billable worker').check();
      }
      await submit.click();
      await page.getByRole('heading', { name: 'Synthetic browser test', exact: true }).waitFor();
      assert.match(page.url(), /#\/fleet\/(sim|aws)-/);
      // On a phone the open worker comes first: the fleet metrics and mode notice step aside.
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.getByText('Active workers', { exact: true }).isVisible(), false);
      const detailTop = await page
        .getByRole('heading', { name: 'Synthetic browser test', exact: true })
        .evaluate((h) => h.getBoundingClientRect().top);
      if (aws) assert.equal(await page.getByText('Cloud mode', { exact: true }).isVisible(), true);
      else assert.ok(detailTop < 400, `worker detail starts at ${detailTop}px on a phone`);
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.equal(await page.getByText('Active workers', { exact: true }).isVisible(), true);

      if (!aws) {
        await launch(page, 'Unscoped worker');
        await submit.click();
        await page.getByRole('heading', { name: 'Unscoped worker', exact: true }).waitFor();
        // Project picker: choosing demo-app filters the fleet, the history and the scope chip.
        await page.getByRole('button', { name: 'Project: All projects' }).click();
        await page.getByRole('option', { name: /demo-app/ }).click();
        await page.waitForURL(/\?project=demo-app/);
        const list = page.getByRole('list', { name: 'Workers' });
        await list.getByText('Synthetic browser test').waitFor();
        assert.equal(await list.getByText('Unscoped worker').count(), 0);
        await page.getByRole('link', { name: 'Event history' }).click();
        await page.getByRole('heading', { name: 'Fleet history' }).waitFor();
        assert.equal(await page.getByRole('main').getByText('Unscoped worker').count(), 0);
        await page.getByRole('main').getByRole('link', { name: 'Synthetic browser test' }).first().click();
        await page.getByRole('heading', { name: 'Synthetic browser test', exact: true }).waitFor();
        // Statuses use the shared role map: stopping turns the pill to the warning role.
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
        assert.equal(
          await page.getByRole('main').getByRole('img', { name: 'Status: Stopped' }).first().getAttribute('data-role'),
          'warning',
        );
        await page.reload();
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Terminate', exact: true }).hover();
        await page.getByRole('tooltip').filter({ hasText: 'Its history and collected files stay.' }).first().waitFor();
        await page.mouse.move(0, 0);
      }

      if (aws) {
        await page.getByLabel('Shell command').fill('printf synthetic');
        await page.getByRole('button', { name: 'Run command' }).click();
        await page.getByRole('button', { name: 'Refresh result' }).click();
        await page.getByText('synthetic browser result', { exact: true }).waitFor();
        assert.equal(await page.getByText('$0', { exact: true }).count(), 0);
        await page.getByRole('tab', { name: 'Terminal and files' }).click();
        await page.getByLabel('Artifact path').fill('result.txt');
        await page.getByRole('button', { name: 'Collect artifact' }).click();
        await page.getByRole('link', { name: 'result.txt' }).waitFor();
        const href = await page.getByRole('link', { name: 'result.txt' }).getAttribute('href');
        const download = await context.request.get(new URL(href, page.url()).href);
        assert.equal(await download.text(), 'file evidence');
      }

      await noOverflowNoAxe(page);
      await page.screenshot({ path: `docs/${aws ? 'aws-fixture' : 'simulation'}-acceptance.png`, fullPage: true });

      await page.getByRole('button', { name: 'Terminate', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm termination' }).click();
      if (aws) await page.getByRole('tab', { name: /History/ }).click();
      await page
        .getByText(aws ? 'AWS terminate requested.' : 'Simulated terminate requested.', { exact: true })
        .waitFor();

      if (!aws) {
        // Ask opens a drawer that hands over to Sindri's Overview (its Guide); project IDs are per app.
        await page.getByRole('button', { name: 'Ask', exact: true }).click();
        const drawer = page.getByRole('dialog', { name: 'Ask the Guide' });
        await drawer.getByText('Skidbladnir has no Sindri token', { exact: false }).waitFor();
        assert.equal(
          await drawer.getByRole('link', { name: 'Open the Guide in Sindri' }).getAttribute('href'),
          'http://127.0.0.1:4310/#/overview',
        );
        await page.keyboard.press('Escape');
        await page.getByRole('link', { name: 'Docs', exact: true }).click();
        await page.getByRole('heading', { name: 'Skidbladnir screens', level: 1 }).waitFor();
        assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, 'one H1 on a docs page');
        await page.getByRole('searchbox', { name: 'Search the docs' }).fill('terminated');
        await page
          .getByRole('navigation', { name: 'Search results' })
          .getByRole('link', { name: /Terminated \(worker status\)/ })
          .click();
        // Search finds the heading, not just the page: the link opens Statuses at that status.
        await page.getByRole('heading', { name: 'Statuses' }).first().waitFor();
        if (!page.url().includes('#terminated-worker-status'))
          throw new Error('docs search did not link to the heading');
        await noOverflowNoAxe(page);
        const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await page.emulateMedia({ colorScheme: 'dark' });
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), light);
      }
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          mode: aws ? 'AWS fixture, no cloud resources' : 'simulation',
          viewports: 3,
          axeViolations: 0,
          errors,
        }),
      );
    } finally {
      await context.close();
      await app.close();
    }
  }
} finally {
  await browser.close();
}
