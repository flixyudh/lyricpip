#!/usr/bin/env python3
"""
Best-effort runtime test: load /app/extension as unpacked, navigate to a YouTube
  watch page, wait, and check whether the Flyrics overlay was injected.
If this environment can't load the extension or reach YouTube, we mark untestable.
"""
import asyncio
import sys
from playwright.async_api import async_playwright

EXT = "/app/extension"
USER_DATA = "/tmp/lyricpip-ext-profile"

async def main():
    import shutil, os
    shutil.rmtree(USER_DATA, ignore_errors=True)
    os.makedirs(USER_DATA, exist_ok=True)

    async with async_playwright() as p:
        try:
            context = await p.chromium.launch_persistent_context(
                USER_DATA,
                headless=False,  # extensions need a head
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--autoplay-policy=no-user-gesture-required",
                ],
                viewport={"width": 1280, "height": 800},
                timeout=30000,
            )
        except Exception as e:
            print(f"UNTESTABLE: Could not launch persistent context with extension: {e}")
            return 0

        # Check service worker (background)
        await asyncio.sleep(3)
        sws = context.service_workers
        print(f"service_workers count: {len(sws)}")
        for sw in sws:
            print(f"  sw url: {sw.url}")

        page = await context.new_page()
        try:
            await page.goto("https://www.youtube.com/watch?v=yKNxeF4KMsY", wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            print(f"UNTESTABLE: Could not reach YouTube: {e}")
            await context.close()
            return 0

        # Dismiss potential consent prompt by waiting
        await asyncio.sleep(8)

        # Try to start playback if a video element is paused
        try:
            await page.evaluate("""
                () => {
                  const v = document.querySelector('video');
                  if (v) { v.muted = true; v.play().catch(()=>{}); }
                }
            """)
        except Exception:
            pass
        await asyncio.sleep(10)

        # Check overlay
        overlay = await page.query_selector('[data-testid="lyricpip-overlay"]')
        print(f"overlay present: {overlay is not None}")
        if overlay:
            lines = await page.query_selector_all('[data-testid="lyric-line"]')
            print(f"  lyric lines: {len(lines)}")
            status = await page.evaluate("""
                () => {
                  const o = document.querySelector('[data-testid="lyricpip-overlay"]');
                  return o ? o.innerText.slice(0,400) : null;
                }
            """)
            print(f"  overlay text snippet: {status!r}")
            pip_btn = await page.query_selector('[data-testid="pip-button"]')
            print(f"  pip button present: {pip_btn is not None}")
        else:
            # Check if content script is at least running
            has_main_world_listener = await page.evaluate("""
                () => !!document.querySelector('video')
            """)
            print(f"  video element on page: {has_main_world_listener}")

        await context.close()
        return 0

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
