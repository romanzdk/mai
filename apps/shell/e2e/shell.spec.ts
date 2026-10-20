import { expect, type Page, test } from '@playwright/test';

const input = (page: Page) => page.getByLabel('request');

async function say(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press('Enter');
}

async function dispatch(page: Page, text: string) {
  await page.goto('/');
  await say(page, text);
  return page
    .getByTestId('board')
    .getByRole('button', { name: new RegExp(text) })
    .first();
}

test('shows the daemon as connected with a ping round-trip', async ({ page }) => {
  await page.goto('/');
  const status = page.getByTestId('daemon-status');
  await expect(status).toContainText('daemon connected');
  await expect(status.locator('[title]').first()).toHaveAttribute('title', /rtt \d+ ms/, {
    timeout: 5000,
  });
});

test('a question gets a desk answer', async ({ page }) => {
  await page.goto('/');
  await say(page, 'what time is it');
  await expect(page.getByTestId('conversation')).toContainText('echo: what time is it');
});

test('a dispatched job shows on the board and opens with its report', async ({ page }) => {
  const row = await dispatch(page, 'run a job please');
  await expect(row).toContainText('done');
  await row.click();
  await expect(page.getByTestId('report')).toContainText('Fake report.');
  await expect(page.getByText('Bash echo working')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeVisible();
});

test('a risky step waits for approval; approving lets it finish', async ({ page }) => {
  await dispatch(page, 'job approve-me delete');
  const card = page.getByTestId('approval').filter({ hasText: 'approve-me' });
  await expect(card).toContainText('rm -rf ~/Documents/old');
  await expect(card).toContainText('You asked');
  await expect(card).toContainText('Outside the job folder: ~/Documents/old');
  await expect(card).toContainText('Deletes permanently');
  await expect(card.getByRole('checkbox')).toHaveCount(0);
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card).toHaveCount(0);
  const row = page.getByTestId('board').getByRole('button', { name: /approve-me/ });
  await expect(row).toContainText('done');
});

test('denying stops the job and says why', async ({ page }) => {
  await dispatch(page, 'job deny-me delete');
  await page
    .getByTestId('approval')
    .filter({ hasText: 'deny-me' })
    .getByRole('button', { name: 'Deny and stop job', exact: true })
    .click();
  const row = page.getByTestId('board').getByRole('button', { name: /deny-me/ });
  await expect(row).toContainText('failed');
  await row.click();
  await expect(page.locator('.stopped')).toHaveText('Stopped: you denied: rm -rf ~/Documents/old');
});

test('cancel stops a running job and retry opens the new run', async ({ page }) => {
  const row = await dispatch(page, 'job cancel-me slow');
  await expect(row).toContainText('running');
  await row.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.stopped')).toHaveText('Cancelled by you.');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.meta')).toContainText('running');
  await expect(page.locator('.meta')).toContainText('retry of');
  await page.keyboard.press('Escape');
  await expect(
    page.getByTestId('board').getByRole('button', { name: /cancel-me slow/ }),
  ).toHaveCount(2);
});

test('the inbox lists pending approvals and closes when emptied', async ({ page }) => {
  await dispatch(page, 'job inbox-me delete');
  await page.getByRole('button', { name: /^inbox [1-9]/ }).click();
  const card = page.getByTestId('inbox').getByTestId('approval').filter({ hasText: 'inbox-me' });
  await expect(card).toBeVisible();
  for (const deny of await page.getByRole('button', { name: 'Deny and stop job' }).all()) {
    await deny.click();
  }
  await expect(page.getByTestId('board')).toBeVisible();
});

test('in a job view the input asks about that job', async ({ page }) => {
  const row = await dispatch(page, 'job followup-target');
  await expect(row).toContainText('done');
  await row.click();
  await expect(page.getByTestId('about-chip')).toContainText('job followup-target');
  await say(page, 'what changed?');
  const thread = page.locator('.job-view').getByTestId('conversation');
  await expect(thread).toContainText('what changed?');
  await expect(thread).toContainText('echo: what changed?');
});

test('history search finds old jobs by any word, arrows and Enter open one', async ({ page }) => {
  await expect(await dispatch(page, 'job history-alpha')).toContainText('done');
  await expect(await dispatch(page, 'job history-beta')).toContainText('done');
  await page.getByRole('button', { name: 'history', exact: true }).click();
  await page.getByLabel('search jobs').fill('history-beta');
  const results = page.getByTestId('history').getByRole('button', { name: /history-/ });
  await expect(results).toHaveCount(1);
  await page.getByLabel('search jobs').press('Enter');
  await expect(page.locator('.job-view h1')).toHaveText('job history-beta');
});

test('keyboard: approve with Mod+Y, open a row with Mod+1, focus returns to the input', async ({
  page,
}) => {
  await dispatch(page, 'job key-approve delete');
  const card = page.getByTestId('approval').filter({ hasText: 'key-approve' });
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+y');
  await expect(card).toHaveCount(0);

  const row = page.getByTestId('board').getByRole('button', { name: /key-approve/ });
  const key = (await row.locator('.job-key').textContent())?.trim();
  expect(key).toMatch(/^[1-9]$/);
  await page.keyboard.press(`ControlOrMeta+${key}`);
  await expect(page.locator('.job-view h1')).toHaveText('job key-approve delete');
  await page.locator('.job-view h1').click();
  await page.keyboard.press('Escape');
  await expect(input(page)).toBeFocused();

  await page.getByTestId('board').click({ position: { x: 5, y: 5 } });
  await page.keyboard.type('hello');
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue(/hello$/);
});

test('arrow up recalls earlier requests; Shift+Enter makes a new line', async ({ page }) => {
  await page.goto('/');
  await say(page, 'first request');
  await expect(page.getByTestId('conversation')).toContainText('echo: first request');
  await input(page).press('ArrowUp');
  await expect(input(page)).toHaveValue('first request');
  await input(page).fill('line one');
  await input(page).press('Shift+Enter');
  await input(page).pressSequentially('line two');
  await expect(input(page)).toHaveValue('line one\nline two');
});

test('a mouse click on a button hands focus back to the input', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^inbox/ }).click();
  await expect(input(page)).toBeFocused();
  await page.keyboard.type('dictated');
  await expect(input(page)).toHaveValue('dictated');
});

test('top bar shows job counts, plan usage and the clock; inbox sits in the sidebar', async ({
  page,
}) => {
  await dispatch(page, 'job sidebar-me delete');
  const bar = page.getByTestId('daemon-status');
  await expect(bar.getByTestId('usage')).toContainText('42%');
  await expect(bar.getByTestId('usage')).toContainText('18%');
  await expect(bar.getByTestId('job-counts')).toContainText('needs you');
  await expect(bar.locator('time.clock')).toHaveText(/\d{2}:\d{2}/);
  const side = page.getByTestId('inbox-side');
  await expect(side.getByTestId('approval').filter({ hasText: 'sidebar-me' })).toBeVisible();
  const row = page.getByTestId('board').getByRole('button', { name: /sidebar-me/ });
  await expect(row).toContainText('approve: rm -rf ~/Documents/old');
  await side.getByRole('button', { name: 'Deny and stop job' }).first().click();
  await expect(row).toContainText('failed');
});

test('settings save, survive a reload, and are clamped by the daemon', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('daemon-status')).toContainText('daemon connected');
  await page.keyboard.press('ControlOrMeta+,');
  const view = page.getByTestId('settings');
  const parallel = view.getByLabel('Jobs at once');
  await parallel.fill('99');
  await parallel.press('Enter');
  await expect(parallel).toHaveValue('8');
  await parallel.fill('3');
  await parallel.press('Enter');
  await page.reload();
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await expect(page.getByTestId('settings').getByLabel('Jobs at once')).toHaveValue('3');
  await page.getByTestId('settings').getByLabel('Jobs at once').fill('2');
  await page.getByTestId('settings').getByLabel('Jobs at once').press('Enter');
});

test('new jobs are held near the plan limit until "Run anyway"', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  const hold = page.getByTestId('settings').getByLabel('Hold new jobs at');
  await hold.fill('40');
  await hold.press('Enter');
  const banner = page.getByTestId('paused');
  await expect(banner).toContainText('the 5-hour limit is at 42%');
  await page.keyboard.press('Escape');
  await say(page, 'job held-me');
  const row = page.getByTestId('board').getByRole('button', { name: /held-me/ });
  await expect(row).toContainText('queued');
  await banner.getByRole('button', { name: 'Run anyway' }).click();
  await expect(row).toContainText('done');
  await expect(banner).toHaveCount(0);
});

test('a schedule made by asking runs on demand, reports to the inbox, pauses and deletes', async ({
  page,
}) => {
  await page.goto('/');
  await say(page, 'every day water the plants');
  const link = page.getByTestId('conversation').getByRole('button', { name: /scheduled: water/ });
  await expect(link).toContainText('daily at 08:00');
  await link.click();
  const card = page.getByTestId('schedules').getByRole('region', { name: 'water the plants' });
  await expect(card).toContainText('Next run');
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card).toContainText(/ago · (new report|done)/);
  await page.keyboard.press('Escape');
  const side = page.getByTestId('inbox-side');
  await expect(side).toContainText('water the plants');
  await page.getByRole('button', { name: 'schedules', exact: true }).click();
  await card.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(card).toContainText('paused');
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  await card.getByRole('button', { name: 'Yes, delete', exact: true }).click();
  await expect(card).toHaveCount(0);
});
