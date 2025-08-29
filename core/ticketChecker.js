const { chromium } = require("playwright");
const { parseExpeditionText } = require("../utils/formatter");

const browsers = new Map();
const pages = new Map();
const stopCheckingFlags = new Map();
const stopProgressFlags = new Map();

async function createStealthBrowser(headless) {
  const browser = await chromium.launch({
    headless: headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", {
      get: () => ["tr-TR", "tr"],
    });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3],
    });
  });

  return { browser, context };
}

async function launchBrowser(chatId) {
  if (!browsers.has(chatId)) {
    const { browser, context } = await createStealthBrowser(true);
    const page = await context.newPage();
    browsers.set(chatId, browser);
    pages.set(chatId, page);
  }
}

async function closeBrowser(chatId) {
  if (browsers.has(chatId)) {
    await browsers.get(chatId).close();
    browsers.delete(chatId);
    pages.delete(chatId);
  }
}

function shouldStop(chatId) {
  return stopProgressFlags.get(chatId);
}

async function closeListBrowser(chatId) {
  await closeBrowser(chatId);
}

async function checkIfSeatAvailable(
  pageLocal,
  expeditionId,
  selectedSeatClass
) {
  const buttons = await pageLocal.$$(
    `#collapseBody${expeditionId.replace(
      "btn",
      ""
    )} button[id^="sefer-"][id$="-departure"]`
  );

  for (const button of buttons) {
    const text = await button.innerText();
    const lines = text
      .trim()
      .split("\n")
      .map((l) => l.trim());

    if (lines[0] === selectedSeatClass.toUpperCase()) {
      const isFull = lines.some((line) => line.toUpperCase().includes("DOLU"));
      if (!isFull) {
        return true;
      }
    }
  }
  return false;
}

async function clickWithCheck(selector, chatId) {
  if (shouldStop(chatId)) return false;

  try {
    const page = pages.get(chatId);
    await page.waitForSelector(selector, { timeout: 15000 });
    await page.click(selector);
    await page.waitForTimeout(500);
    return true;
  } catch (e) {
    console.error(`Hata (selector: ${selector}, chatId: ${chatId}):`, e);
    return false;
  }
}

async function waitForOverlay(page) {
  try {
    await page.waitForSelector(".vld-overlay.is-active", {
      state: "hidden",
      timeout: 5000,
    });
  } catch {
    console.log("Overlay gözükmedi veya timeout oldu, devam ediliyor...");
  }
}

async function getExpeditionList(from, to, date, chatId) {
  stopProgressFlags.set(chatId, false);
  await launchBrowser(chatId);

  const page = pages.get(chatId);

  try {
    await page.goto("https://ebilet.tcddtasimacilik.gov.tr/", {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await page.waitForTimeout(1000);

    const actions = [
      () => clickWithCheck("#fromTrainInput", chatId),
      () => clickWithCheck(`#gidis-${from}`, chatId),
      () => clickWithCheck("#toTrainInput", chatId),
      () => clickWithCheck(`#donus-${to}`, chatId),
      () => clickWithCheck(".departureDate", chatId),
      () => clickWithCheck(`td:not(.off) > [id="${date}"]`, chatId),
      () => clickWithCheck("#searchSeferButton", chatId),
    ];

    for (const action of actions) {
      const result = await action();
      if (!result) {
        return null;
      }
    }

    await page.waitForTimeout(2000);

    if (shouldStop(chatId)) return null;

    await page.waitForSelector(".seferInformationArea", { timeout: 20000 });

    const expeditionButtons = await page.$$(`button[id^="gidis"][id$="btn"]`);
    const expeditionList = [];

    for (const btn of expeditionButtons) {
      const id = await btn.getAttribute("id");
      const text = await btn.innerText();
      const expeditionData = parseExpeditionText(text);
      expeditionList.push({
        id,
        text,
        departureDate: expeditionData.date,
        departureTime: expeditionData.departureTime,
      });
    }

    return expeditionList;
  } catch (err) {
    console.error("getExpeditionList error:", err);
    return null;
  } finally {
    await closeBrowser(chatId);
  }
}

async function checkSelectedExpedition(
  from,
  to,
  date,
  seat,
  expeditionId,
  departureDate,
  departureTime
) {
  const { browser, context } = await createStealthBrowser(true);
  const pageLocal = await context.newPage();

  try {
    await pageLocal.goto("https://ebilet.tcddtasimacilik.gov.tr/", {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await pageLocal.waitForTimeout(1000);

    const selectors = [
      "#fromTrainInput",
      `#gidis-${from}`,
      "#toTrainInput",
      `#donus-${to}`,
      ".departureDate",
      `td:not(.off) > [id="${date}"]`,
      "#searchSeferButton",
    ];

    for (const selector of selectors) {
      await pageLocal.waitForSelector(selector, { timeout: 15000 });
      await pageLocal.click(selector);
      await pageLocal.waitForTimeout(500);
    }

    const [day, month, year] = departureDate.split(".");
    const [hours, minutes] = departureTime.split(":");
    const expeditionDateObj = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hours),
      parseInt(minutes),
      0
    );
    const cutoffTime = new Date(expeditionDateObj.getTime() - 15 * 60 * 1000);
    const now = new Date();

    if (now.getTime() > cutoffTime.getTime()) {
      return "EXPIRED";
    }

    const expeditionButton = await pageLocal.$(`#${expeditionId}`);
    if (expeditionButton) {
      const priceText = await expeditionButton.$eval(".price", (el) =>
        el.innerText.trim().toLowerCase()
      );
      if (priceText === "dolu") return false;
    }

    await waitForOverlay(pageLocal);
    await pageLocal.click(`#${expeditionId}`);
    await pageLocal.waitForTimeout(1000);

    const result = await checkIfSeatAvailable(pageLocal, expeditionId, seat);
    return result;
  } catch (err) {
    console.error("Sefer kontrolünde hata:", err);
    return false;
  } finally {
    await browser.close();
  }
}

async function startCheckingLoop(
  from,
  to,
  date,
  seat,
  expeditionId,
  departureDate,
  departureTime,
  callbacks = {},
  chatId
) {
  stopCheckingFlags.set(chatId, false);
  let isFull = false;

  try {
    while (!stopCheckingFlags.get(chatId)) {
      const result = await checkSelectedExpedition(
        from,
        to,
        date,
        seat,
        expeditionId,
        departureDate,
        departureTime
      );
      if (stopCheckingFlags.get(chatId)) break;

      if (result === "EXPIRED") {
        if (callbacks.onExpired) await callbacks.onExpired();
        break;
      }

      if (result) {
        if (callbacks.onFound)
          await callbacks.onFound("🚨 Boş yer açıldı! Hemen kontrol et.");
        stopCheckingLoop(chatId);
        break;
      } else if (!isFull) {
        isFull = true;
        if (callbacks.onCheck)
          await callbacks.onCheck(
            "❌ Sefer şu anda dolu. Boş yer açılınca haber verilecektir."
          );
      }

      await new Promise((r) => setTimeout(r, 10000));
    }
  } catch (err) {
    if (callbacks.onError) await callbacks.onError(err);
  } finally {
    stopCheckingFlags.delete(chatId);
    await closeBrowser(chatId);
  }
}

function stopCheckingLoop(chatId) {
  stopCheckingFlags.set(chatId, true);
  stopProgressFlags.set(chatId, true);
}

function setStopFlag(chatId) {
  stopProgressFlags.set(chatId, true);
}

module.exports = {
  getExpeditionList,
  closeListBrowser,
  startCheckingLoop,
  stopCheckingLoop,
  setStopFlag,
};
