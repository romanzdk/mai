import { expect, test } from '@playwright/test';

test('shows the daemon as connected with a ping round-trip', async ({ page }) => {
  await page.goto('/');
  const status = page.getByTestId('daemon-status');
  await expect(status).toContainText('daemon connected');
  await expect(status).toContainText(/rtt \d+ ms/, { timeout: 5000 });
});
