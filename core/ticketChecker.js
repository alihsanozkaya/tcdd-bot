import { chromium } from "playwright";
import { parseTripText } from "../utils/formatter.js";

const userBrowsers = new Map();
const activeTabs = new Map();
const activeTasks = new Map();
const firstCheckDone = new Map();

async function getBrowserForUser(userId) {
  if (!userBrowsers.has(userId)) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    userBrowsers.set(userId, browser);
  }
  return userBrowsers.get(userId);
}

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
    await page.close().catch(() => {});
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
    await page.waitForSelector(".seferInformationArea");

    const tripButtons = await page.$$('button[id^="gidis"][id*="btn"]');
    const tripList = [];

    for (const btn of tripButtons) {
      const text = await btn.innerText();
      if (text && text.toUpperCase().includes("YHT")) {
        const id = await btn.getAttribute("id");
        const tripData = parseTripText(text);
        tripList.push({
          id,
          text,
          departureStation: tripData.departureStation,
          arrivalStation: tripData.arrivalStation,
          departureDate: tripData.date,
          departureTime: tripData.departureTime,
        });
      }
    }

    await page.close();
    return tripList;
  } catch (err) {
    await page.close().catch(() => {});
    return [];
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
  callbacks = {}
) {
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
        const tripDateTime = new Date(`${date} ${trip.departureTime}`);
        if (tripDateTime < now) {
          tripList.splice(i, 1);
          if (callbacks.onTripExpired) await callbacks.onTripExpired(trip);
        }
      }

      if (tripList.length === 0) {
        if (callbacks.onAllExpired) await callbacks.onAllExpired(searchId);
        stopChecker(searchId);
        return;
      }

      for (const trip of [...tripList]) {
        if (activeTasks.get(searchId)) break;

        const tripDateTime = new Date(`${date} ${trip.departureTime}`);
        if (tripDateTime < now) continue;

        const result = await checkSingleTrip(page, trip, seatClass);

        if (result) {
          anyAvailable = true;
          if (callbacks.onFound) await callbacks.onFound(trip, searchId);
          stopChecker(searchId);
          return;
        } else if (isFirstCheck && callbacks.onCheck && !hasSentCheckMessage) {
          await callbacks.onCheck(trip);
          hasSentCheckMessage = true;
        }
      }

      firstCheckDone.set(searchId, true);

      if (!anyAvailable) {
        const allExpired = tripList.every(
          (trip) => new Date(`${date} ${trip.departureTime}`) < now
        );
        if (allExpired && callbacks.onAllExpired) {
          await callbacks.onAllExpired(searchId);
          stopChecker(searchId);
          return;
        }
      }

      await new Promise((r) => setTimeout(r, 120000));

      if (!activeTasks.get(searchId)) {
        await page.reload({ waitUntil: "networkidle" }).catch(() => {});
        await page
          .waitForSelector(".seferInformationArea", { timeout: 10000 })
          .catch(() => {});
      }
    }
  } catch (err) {
    if (callbacks.onError) await callbacks.onError(err);
  }
}

async function checkSingleTrip(page, trip, seatClass) {
  try {
    let btn;
    if (trip.id && trip.id !== "") {
      btn = await page.$(`#${trip.id}`);
    } else {
      btn = await page
        .locator(
          `.seferInformationArea button:has-text("${trip.departureTime}")`
        )
        .first();
    }

    if (!btn) return false;

    const statusText = await btn.innerText();
    if (
      statusText.toUpperCase().includes("DOLU") &&
      !statusText.toUpperCase().includes("SEÇ")
    )
      return false;

    await btn.click();
    await page.waitForTimeout(1200);

    const targetClass = seatClass.toUpperCase().trim();
    const classButtons = page.locator(
      '.collapse.show button, [aria-expanded="true"] + .collapse button'
    );

    const count = await classButtons.count();
    let isAvailable = false;

    for (let i = 0; i < count; i++) {
      const b = classButtons.nth(i);
      const text = await b.innerText();

      if (text.toUpperCase().includes(targetClass)) {
        const isDisabled = await b.getAttribute("disabled");
        if (!text.toUpperCase().includes("DOLU") && isDisabled == null) {
          isAvailable = true;
          break;
        }
      }
    }

    if (!isAvailable) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(300);
    }

    return isAvailable;
  } catch (err) {
    return false;
  }
}

export function stopChecker(searchId) {
  activeTasks.set(searchId, true);
  closeSearchTab(searchId);
}
