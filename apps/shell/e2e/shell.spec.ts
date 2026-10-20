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
