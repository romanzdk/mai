import { expect, test } from '@playwright/test';

test('shows the daemon as connected with a ping round-trip', async ({ page }) => {
  await page.goto('/');
  const status = page.getByTestId('daemon-status');
  await expect(status).toContainText('daemon connected');
  await expect(status).toContainText(/rtt \d+ ms/, { timeout: 5000 });
});

test('a question gets a desk answer', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('request').fill('what time is it');
  await page.getByLabel('request').press('Enter');
  await expect(page.getByTestId('conversation')).toContainText('echo: what time is it');
});

test('a dispatched job shows on the board and opens with its report', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('request').fill('run a job please');
  await page.getByLabel('request').press('Enter');
  const row = page
    .getByTestId('board')
    .getByRole('button', { name: /run a job please/ })
    .first();
  await expect(row).toContainText('done');
  await row.click();
  await expect(page.getByTestId('report')).toContainText('Fake report.');
  await expect(page.getByText('Bash echo working')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeVisible();
});

async function dispatch(page: import('@playwright/test').Page, text: string) {
  await page.goto('/');
  await page.getByLabel('request').fill(text);
  await page.getByLabel('request').press('Enter');
  return page
    .getByTestId('board')
    .getByRole('button', { name: new RegExp(text) })
    .first();
}

test('a risky step waits for approval; approving lets it finish', async ({ page }) => {
  const row = await dispatch(page, 'job approve-me delete');
  await expect(row).toContainText('waiting approval');
  const card = page.getByTestId('approval').filter({ hasText: 'approve-me' });
  await expect(card).toContainText('rm -rf ~/Documents/old');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(row).toContainText('done');
  await expect(card).toHaveCount(0);
});

test('denying fails the job with a clear reason', async ({ page }) => {
  const row = await dispatch(page, 'job deny-me delete');
  await page
    .getByTestId('approval')
    .filter({ hasText: 'deny-me' })
    .getByRole('button', { name: 'Deny', exact: true })
    .click();
  await expect(row).toContainText('failed');
  await row.click();
  await expect(page.locator('p.error')).toHaveText('you denied: rm -rf ~/Documents/old');
});

test('cancel stops a running job and retry runs it again', async ({ page }) => {
  const row = await dispatch(page, 'job cancel-me slow');
  await expect(row).toContainText('running');
  await row.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.job-view-head')).toContainText('cancelled');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByTestId('board').getByRole('button', { name: /cancel-me slow/ }),
  ).toHaveCount(2);
});

test('the inbox lists pending approvals', async ({ page }) => {
  await dispatch(page, 'job inbox-me delete');
  await page.getByRole('button', { name: /^inbox [1-9]/ }).click();
  const card = page.getByTestId('inbox').getByTestId('approval').filter({ hasText: 'inbox-me' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(card).toHaveCount(0);
});
