import { test, expect } from '@playwright/test';

test('oi-wiki has title', async ({ page }) => {
  await page.goto('https://oi-wiki.org/', {
    waitUntil: 'domcontentloaded',
  });

  await expect(page).toHaveTitle(/OI Wiki/);
});

test('oi-wiki has catalog', async ({ page }) => {
  await page.goto('https://oi-wiki.org/', {
    waitUntil: 'domcontentloaded',
  });

  await expect(page.getByRole('link', { name: '简介' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '比赛相关' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '工具软件' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '语言基础' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '算法基础' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '搜索' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '动态规划' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '字符串' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '数学' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '数据结构' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '图论' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '计算几何' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '杂项' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '专题' }).first()).toBeVisible();
});