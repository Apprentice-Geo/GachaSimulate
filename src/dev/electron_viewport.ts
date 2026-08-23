import { type CDPSession, type Page } from "playwright";

export async function emulate_viewport(
  page: Page,
  width: number,
  height: number,
): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return session;
  } catch (error) {
    await session.detach();
    throw error;
  }
}
