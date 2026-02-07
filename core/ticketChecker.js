import { chromium } from "playwright";
import { parseTripText } from "../utils/formatter.js";

//#region STATE MANAGEMENT
const userBrowsers = new Map();
const activeTabs = new Map();
const activeTasks = new Map();
const firstCheckDone = new Map();
const searchUserMap = new Map();
//#endregion

//#region Browser açma
async function getBrowserForUser(userId) {
  if (!userBrowsers.has(userId)) {
    const browser = await chromium.launch({
      headless: false,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
      ],
    });
    userBrowsers.set(userId, browser);
  }
  return userBrowsers.get(userId);
}
//#endregion

//#region Browser kapatma
export async function closeUserBrowser(userId) {
  const browser = userBrowsers.get(userId);
  if (browser) {
    await browser.close();
    userBrowsers.delete(userId);
  }
}
//#endregion

async function getPageForSearch(userId, searchId) {
  if (!activeTabs.has(searchId)) {
    const browser = await getBrowserForUser(userId);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    activeTabs.set(searchId, page);
  }
  return activeTabs.get(searchId);
}

export async function closeSearchTab(searchId) {
  const page = activeTabs.get(searchId);
  if (page) {
    await page.close();
    activeTabs.delete(searchId);
  }
}

export async function getTripList(userId, from, to, date) {
  const browser = await getBrowserForUser(userId);
  const page = await browser.newPage();

  try {
    await page.goto("https://ebilet.tcddtasimacilik.gov.tr/", {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await page.waitForSelector("#fromTrainInput");
    await page.click("#fromTrainInput");

    await page.waitForTimeout(100);
    await page.click(`#gidis-${from}`);

    await page.waitForTimeout(100);
    await page.click("#toTrainInput");

    await page.waitForTimeout(100);
    await page.click(`#donus-${to}`);

    await page.waitForTimeout(100);
    await page.click(".departureDate");

    await page.waitForTimeout(500);

    const [day, month, year] = date.split(" ");
    let dateElement =
      (await page.$(`td:not(.off) > [id="${date}"]`)) ||
      (await page.$(`td:not(.off)[data-date="${day}/${month}/${year}"]`));

    if (dateElement) {
      await dateElement.click();
      await page.waitForTimeout(500);
    } else {
      await page.close();
      return [];
    }

    const searchBtn = await page.waitForSelector("#searchSeferButton", {
      state: "visible",
    });
    await searchBtn.click();

    await page.waitForTimeout(2000);
    await page.waitForSelector(".seferInformationArea", { timeout: 30000 });
    await page.waitForTimeout(2000);
    const tripCards = await page.$$(".card");
    const tripList = [];

    for (const card of tripCards) {
      try {
        const header = await card.$(".card-header");
        if (!header) continue;

        const tripId = await header.getAttribute("id");
        if (!tripId || !tripId.includes("sefer")) continue;

        const btn = await header.$("button");
        if (!btn) continue;

        const text = await btn.innerText();

        if (
          text &&
          text.toUpperCase().includes("YHT") &&
          !text.toUpperCase().includes("ANAHAT")
        ) {
          const tripData = parseTripText(text);

          tripList.push({
            tripId: tripId,
            departureTime: tripData.departureTime,
            departureStation: tripData.departureStation,
            arrivalStation: tripData.arrivalStation,
            departureDate: date,
            text: text.trim(),
          });
        }
      } catch (cardErr) {
        console.error("Kart okunurken hata:", cardErr);
        continue;
      }
    }

    return tripList;
  } catch (err) {
    return [];
  } finally {
    if (page) await page.close();
  }
}

export async function startMultiTripChecker(
  userId,
  searchId,
  from,
  to,
  date,
  seatClass,
  tripList,
  callbacks = {},
) {
  searchUserMap.set(searchId, userId);
  activeTasks.set(searchId, false);
  firstCheckDone.set(searchId, false);
  let hasSentCheckMessage = false;
  const page = await getPageForSearch(userId, searchId);

  try {
    await page.goto("https://ebilet.tcddtasimacilik.gov.tr/", {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    await page.waitForSelector("#fromTrainInput");
    await page.click("#fromTrainInput");

    await page.waitForTimeout(100);
    await page.click(`#gidis-${from}`);

    await page.waitForTimeout(100);
    await page.click("#toTrainInput");

    await page.waitForTimeout(100);
    await page.click(`#donus-${to}`);

    await page.waitForTimeout(100);
    await page.click(".departureDate");

    await page.waitForTimeout(500);

    const [day, month, year] = date.split(" ");
    const dateElement =
      (await page.$(`td:not(.off) > [id="${date}"]`)) ||
      (await page.$(`td:not(.off)[data-date="${day}/${month}/${year}"]`));

    if (dateElement) {
      await dateElement.click();
      await page.waitForTimeout(500);
    } else {
      await page.close();
      return [];
    }

    const searchBtn = await page.waitForSelector("#searchSeferButton", {
      state: "visible",
    });
    await searchBtn.click();

    await page.waitForTimeout(2000);
    await page.waitForSelector(".seferInformationArea");

    while (!activeTasks.get(searchId)) {
      const isFirstCheck = !firstCheckDone.get(searchId);
      let anyAvailable = false;
      const now = new Date();

      for (let i = tripList.length - 1; i >= 0; i--) {
        const trip = tripList[i];

        const tripDateTime = buildTripDateTime(date, trip.departureTime);

        if (tripDateTime < now) {
          tripList.splice(i, 1);
          if (callbacks.onTripExpired) await callbacks.onTripExpired(trip);
        }
      }

      if (tripList.length == 0) {
        if (callbacks.onAllExpired) await callbacks.onAllExpired(searchId);
        await stopChecker(searchId);
        return;
      }

      for (const trip of [...tripList]) {
        if (activeTasks.get(searchId)) break;

        const tripDateTime = buildTripDateTime(date, trip.departureTime);
        if (tripDateTime < now) continue;

        const result = await checkSingleTrip(page, trip, seatClass);

        if (result) {
          anyAvailable = true;
          if (callbacks.onFound) await callbacks.onFound(trip, searchId);
          await stopChecker(searchId);
          return;
        } else if (isFirstCheck && callbacks.onCheck && !hasSentCheckMessage) {
          await callbacks.onCheck(trip);
          hasSentCheckMessage = true;
        }
      }

      firstCheckDone.set(searchId, true);

      if (!anyAvailable) {
        const allExpired = tripList.every(
          (trip) => buildTripDateTime(date, trip.departureTime) < now,
        );

        if (allExpired && callbacks.onAllExpired) {
          await callbacks.onAllExpired(searchId);
          await stopChecker(searchId);
          return;
        }
      }

      await new Promise((r) => setTimeout(r, 120000));

      if (!activeTasks.get(searchId)) {
        await page.evaluate(() => {
          location.reload(true);
        });

        await page.waitForLoadState("domcontentloaded");

        await page
          .waitForSelector(".seferInformationArea", { timeout: 20000 })
          .catch(() => {});
      }
    }
  } catch (err) {
    if (callbacks.onError) await callbacks.onError(err);
    await stopChecker(searchId);
  }
}

async function checkSingleTrip(page, trip, seatClass) {
  try {
    const header = await page.$(`[id="${trip.tripId}"]`);
    if (!header) return false;

    const toggleBtn = await header.$("button");
    if (!toggleBtn) return false;

    const numericId = trip.tripId.replace(/\D/g, "");
    const collapseSelector = `#collapse${numericId}`;

    const isOpen = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.classList.contains("show");
    }, collapseSelector);

    if (!isOpen) {
      await toggleBtn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(120);
      await toggleBtn.click({ force: true });

      await page
        .waitForSelector(`${collapseSelector}.show`, { timeout: 3000 })
        .catch(() => {});
    }

    const targetClass = seatClass.toUpperCase().trim();

    const vagonButtons = await page.$$(
      `button[id*="${numericId}"][id*="vagonType"]`,
    );

    for (const vagonBtn of vagonButtons) {
      const vagonText = (await vagonBtn.innerText()).toUpperCase();

      if (vagonText.includes(targetClass)) {
        const isDisabled = await vagonBtn.getAttribute("disabled");
        const isFull = vagonText.includes("DOLU") || vagonText.includes("(0)");

        if (isDisabled == null && !isFull) return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

export async function stopChecker(searchId) {
  activeTasks.set(searchId, true);

  await closeSearchTab(searchId);

  const userId = searchUserMap.get(searchId);
  searchUserMap.delete(searchId);

  if (userId) {
    const userSearches = [...searchUserMap.entries()].filter(
      ([id, uid]) => uid == userId,
    );

    if (userSearches.length == 0) {
      await closeUserBrowser(userId);
    }
  }
}

function buildTripDateTime(dateStr, timeStr) {
  const [day, month, year] = dateStr.split(" ").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}
