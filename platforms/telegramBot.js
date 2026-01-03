import TelegramBot from "node-telegram-bot-api";
import {
  getTripList,
  startMultiTripChecker,
  stopChecker,
} from "../core/ticketChecker.js";
import { formatActiveSearches, formatTripistItem } from "../utils/formatter.js";
import { getAllSteats } from "../services/seatService.js";
import { getAllStations } from "../services/stationService.js";
import {
  findOrCreateUser,
  getChatIdByUserId,
} from "../services/userService.js";
import {
  getActiveSearchesByUser,
  createSearch,
  stopSearch,
  stopExpiredSearches,
  stopErrorSearch,
  refreshSearchTripList,
  getAllActiveSearches,
  foundSearch,
} from "../services/searchService.js";
import * as MSG from "../utils/messages.js";

//#region STATE MANAGEMENT
const tempStates = new Map();
const STATE_TTL = 15 * 60 * 1000;
let STATIONS_CACHE = null;
let SEATS_CACHE = null;

const setState = (chatId, data) => {
  tempStates.set(chatId, { ...data, updatedAt: Date.now() });
};

const getState = (chatId) => {
  return tempStates.get(chatId);
};

const clearState = (chatId) => {
  tempStates.delete(chatId);
};

setInterval(() => {
  const now = Date.now();
  for (const [chatId, state] of tempStates) {
    if (now - state.updatedAt > STATE_TTL) {
      tempStates.delete(chatId);
    }
  }
}, 5 * 60 * 1000);
//#endregion

//#region BUTTON HELPERS
const stationButtons = (stations, exclude = null) => {
  const filtered = stations.filter((s) => s.code !== exclude);
  const keyboard = [];
  for (let i = 0; i < filtered.length; i += 3) {
    keyboard.push(
      filtered.slice(i, i + 3).map((s) => ({
        text: s.name,
        callback_data: `station_${s.code}`,
      }))
    );
  }
  return { reply_markup: { inline_keyboard: keyboard } };
};

const seatButtons = (seats) => ({
  reply_markup: {
    inline_keyboard: seats.map((s) => [
      { text: s.name, callback_data: `seat_${s._id}` },
    ]),
  },
});
//#endregion

//#region BOT START
export const startTelegramBot = () => {
  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

  (async () => {
    try {
      const activeSearches = await getAllActiveSearches();

      STATIONS_CACHE = await getAllStations();
      SEATS_CACHE = await getAllSteats();

      for (const search of activeSearches) {
        const chatId = await getChatIdByUserId(search.userId);
        const tripList = await getTripList(
          search.userId,
          search.fromStationCode,
          search.toStationCode,
          search.travelDate
        );

        const tripsToCheck = tripList.filter((exp) =>
          search.tripList.includes(exp.departureTime)
        );

        startMultiTripChecker(
          search.userId,
          search._id,
          search.fromStationCode,
          search.toStationCode,
          search.travelDate,
          search.seatType,
          tripsToCheck,
          {
            onFound: async (trip, searchId) => {
              await bot.sendMessage(
                chatId,
                `🎉 YER BULUNDU!\n\n` +
                  `🚉 ${trip.departureStation} → ${trip.arrivalStation}\n\n` +
                  `📅 Tarih: ${trip.departureDate}\n` +
                  `⏱️ Saat: ${trip.departureTime}\n` +
                  `🔗 https://ebilet.tcddtasimacilik.gov.tr/`
              );
              await foundSearch(searchId);
            },
            onTripExpired: async (trip) => {
              const time = typeof trip == "string" ? trip : trip.departureTime;
              await bot.sendMessage(
                chatId,
                `⏰ ${time} seferinin süresi geçti.`
              );
              await refreshSearchTripList(search.data._id);
            },
            onAllExpired: async () => {
              await bot.sendMessage(chatId, MSG.isTripExpired);
              await stopExpiredSearches();
            },
            onError: async (err) => {
              console.error(err);
              await bot.sendMessage(chatId, MSG.errorOccurred);
              await stopErrorSearch(search.data._id);
            },
          }
        );
      }
    } catch (err) {
      console.error("[Kurtarma Hatası]:", err);
    }
  })();

  //#region /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await findOrCreateUser(msg.from.id);
      await bot.sendMessage(chatId, MSG.startMessage);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, MSG.failedCreateUser);
    }
  });
  //#endregion

  //#region /biletbul
  bot.onText(/\/biletbul/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    try {
      const user = await findOrCreateUser(telegramId);
      const searches = await getActiveSearchesByUser(user._id);

      if (searches.length >= 5) {
        await bot.sendMessage(chatId, MSG.activeSearchLimit);
        return;
      }

      setState(msg.chat.id, {
        telegramId: msg.from.id,
        step: "from",
        selectedTrips: [],
      });
      await bot.sendMessage(
        chatId,
        MSG.departureMessage,
        stationButtons(STATIONS_CACHE)
      );
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, MSG.biletbulError);
    }
  });
  //#endregion

  //#region /listele
  bot.onText(/\/listele/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const user = await findOrCreateUser(msg.from.id);
      const searches = await getActiveSearchesByUser(user._id);

      if (!searches.length) return bot.sendMessage(chatId, MSG.noActiveSearch);

      await bot.sendMessage(
        chatId,
        formatActiveSearches(searches, STATIONS_CACHE, SEATS_CACHE)
      );
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, MSG.listeleError);
    }
  });
  //#endregion

  //#region /durdur
  bot.onText(/\/durdur/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const user = await findOrCreateUser(msg.from.id);
      const searches = await getActiveSearchesByUser(user._id);

      if (!searches.length) {
        return bot.sendMessage(chatId, MSG.noActiveSearch);
      }

      setState(chatId, {
        step: "stop-inline",
        searches,
      });

      const stationMap = new Map(
        STATIONS_CACHE.map((st) => [st.code, st.name])
      );

      const buttons = searches.map((search, i) => {
        const times = search.tripList.join(", ");

        const fromName =
          stationMap.get(search.fromStationCode) || search.fromStationCode;
        const toName =
          stationMap.get(search.toStationCode) || search.toStationCode;

        return [
          {
            text: `🛑 ${i + 1}. ${fromName} → ${toName} | ${times}`,
            callback_data: `stop_${search._id}`,
          },
        ];
      });

      buttons.push([
        {
          text: MSG.stopAllSearch,
          callback_data: "stop_all",
        },
      ]);

      buttons.push([
        {
          text: MSG.cancel,
          callback_data: "cancel",
        },
      ]);

      await bot.sendMessage(chatId, MSG.selectStopSearch, {
        reply_markup: {
          inline_keyboard: buttons,
        },
      });
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, MSG.stopListError);
    }
  });
  //#endregion

  //#region CALLBACK QUERY HANDLER
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const state = getState(chatId);

    if (!state) {
      await bot.answerCallbackQuery(query.id, {
        text: MSG.transactionHasExpired,
        show_alert: true,
      });
      return;
    }

    const data = query.data;
    try {
      if (data.startsWith("station_") && state.step == "from") {
        const from = STATIONS_CACHE.find((s) => s.code == data.split("_")[1]);
        if (!from) return clearState(chatId);

        setState(chatId, {
          ...state,
          from: from.code,
          fromName: from.name,
          step: "to",
        });

        await bot.editMessageText(`🚀 Kalkış: ${from.name}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await bot.sendMessage(
          chatId,
          MSG.estimatedMessage,
          stationButtons(STATIONS_CACHE, from.code)
        );
      }
      if (data.startsWith("station_") && state.step == "to") {
        const to = STATIONS_CACHE.find((s) => s.code == data.split("_")[1]);
        if (!to) return clearState(chatId);

        setState(chatId, {
          ...state,
          to: to.code,
          toName: to.name,
          step: "seat",
        });

        await bot.editMessageText(`📍 Varış: ${to.name}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await bot.sendMessage(
          chatId,
          MSG.selectSeatClass,
          seatButtons(SEATS_CACHE)
        );
      }
      if (data.startsWith("seat_") && state.step == "seat") {
        const seat = SEATS_CACHE.find((s) => s._id == data.split("_")[1]);

        if (!seat) return clearState(chatId);

        setState(chatId, {
          ...state,
          seatId: seat._id,
          seatClass: seat.name,
          step: "date",
        });

        await bot.editMessageText(`💺 Koltuk sınıfı: ${seat.name}`, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await bot.sendMessage(chatId, MSG.enterDate);
      }
      if (data === "stop_all") {
        for (const search of state.searches) {
          try {
            await stopSearch(search._id);
            await stopChecker(search._id);
          } catch (e) {
            console.error("Stop error:", search._id, e);
          }
        }

        clearState(chatId);

        await bot.editMessageText("🛑 Tüm aktif aramalar durduruldu.", {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await bot.answerCallbackQuery(query.id);
        return;
      } else if (data === "cancel") {
        clearState(chatId);

        await bot.editMessageText(MSG.searchesContinue, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await bot.answerCallbackQuery(query.id);
        return;
      }
      if (data.startsWith("stop_")) {
        const searchId = data.replace("stop_", "");
        const search = state.searches.find((s) => s._id.toString() == searchId);

        if (!search) {
          clearState(chatId);
          return bot.sendMessage(chatId, MSG.searchNotFound);
        }

        await stopSearch(searchId);
        await stopChecker(searchId);
        clearState(chatId);

        await bot.editMessageText(
          `🛑 Arama durduruldu:\n\n` +
            `🚉 ${search.fromStationCode} → ${search.toStationCode}\n` +
            `📅 Tarih: ${search.travelDate}\n` +
            `⏰ Saatler: ${search.tripList.join(", ")}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
          }
        );
      }
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, MSG.anErrorOccurred);
    }
  });
  //#endregion

  //#region MESSAGE HANDLER
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : "";
    const state = getState(chatId);

    if (!state || text.startsWith("/")) return;

    if (["iptal", "vazgeç", "çık"].includes(text.toLowerCase())) {
      clearState(chatId);
      return bot.sendMessage(chatId, MSG.transactionHasCancelled);
    }

    try {
      if (state.step == "date") {
        if (!/^\d{2} \d{2} \d{4}$/.test(text))
          return bot.sendMessage(chatId, MSG.invalidDate);

        const [day, month, year] = text.split(" ").map(Number);
        const inputDate = new Date(year, month - 1, day);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (inputDate < today)
          return await bot.sendMessage(chatId, MSG.notPastDate);

        const maxDate = new Date(today);
        maxDate.setMonth(maxDate.getMonth() + 2);
        if (inputDate > maxDate)
          return await bot.sendMessage(chatId, MSG.selectMaxDate);

        const user = await findOrCreateUser(state.telegramId);
        const list = await getTripList(user._id, state.from, state.to, text, {
          onScreenshot: async (filePath) => {
            await bot.sendPhoto(chatId, filePath, {
              caption: "📸 Render ortamı ekran görüntüsü",
            });
          },
        });

        if (!list.length) {
          clearState(chatId);
          return bot.sendMessage(chatId, MSG.notTripFound);
        }

        setState(chatId, {
          ...state,
          date: text,
          tripList: list,
          step: "trip",
        });
        await bot.sendMessage(chatId, MSG.listingMessage);

        let msgText = "📅 Sefer Listesi:\n\n";
        list.forEach((e, i) => (msgText += formatTripistItem(e, i) + "\n"));
        msgText += "\nSefer numaralarını yazınız (örn: 1,3)";
        return bot.sendMessage(chatId, msgText);
      }

      if (state.step == "trip") {
        const selections = text
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => Number(s));

        if (!selections.length) {
          await bot.sendMessage(chatId, MSG.requiredTrip);
          return;
        }

        const uniqueSelections = [...new Set(selections)];
        if (uniqueSelections.length !== selections.length) {
          await bot.sendMessage(chatId, MSG.duplicateSelections);
          return;
        }

        const invalidSelections = selections.filter(
          (n) => Number.isNaN(n) || n < 1 || n > state.tripList.length
        );

        if (invalidSelections.length > 0) {
          const max = state.tripList.length;

          const rangeText =
            max == 1
              ? `Sadece 1 numaralı seferi seçebilirsiniz.`
              : `Lütfen 1 - ${max} arası değer giriniz.`;

          await bot.sendMessage(
            chatId,
            `⚠️ Geçersiz sefer numarası.\n` +
              `${rangeText}\n\n` +
              `Örnek: ${max == 1 ? "1" : "1,3"}`
          );
          return;
        }

        const selectedTrips = selections.map((idx) => state.tripList[idx - 1]);

        setState(chatId, {
          ...state,
          selectedTrips,
        });

        await startSearchProcess(bot, chatId, getState(chatId));

        clearState(chatId);
      }
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, MSG.anErrorOccurred);
      clearState(chatId);
    }
  });
  //#endregion
  return bot;
};
//#endregion

//#region StartSearchProcess
async function startSearchProcess(bot, chatId, state) {
  try {
    const user = await findOrCreateUser(state.telegramId);

    let search;
    try {
      search = await createSearch({
        userId: user._id,
        fromStationCode: state.from,
        toStationCode: state.to,
        seatType: state.seatId,
        travelDate: state.date,
        tripList: state.selectedTrips.map((t) => t.departureTime),
      });
    } catch (err) {
      if (err.status === 409) {
        await bot.sendMessage(chatId, `⚠️ ${err.message}`);
        return;
      }
      await bot.sendMessage(chatId, MSG.notSearchSave);
      return;
    }

    if (!search || !search.data) {
      await bot.sendMessage(chatId, MSG.notSearchSave);
      return;
    }

    await bot.sendMessage(
      chatId,
      `🚀 Arama başlatıldı!\n\n` +
        `🚂 ${state.selectedTrips.length} sefer izleniyor\n` +
        `⏱️ Yer bulunca size buradan haber vereceğim.`
    );

    startMultiTripChecker(
      user._id,
      search.data._id,
      state.from,
      state.to,
      state.date,
      state.seatClass,
      state.selectedTrips,
      {
        onFound: async (trip, searchId) => {
          await bot.sendMessage(
            chatId,
            `🎉 YER BULUNDU!\n\n` +
              `🚉 ${trip.departureStation} → ${trip.arrivalStation}\n\n` +
              `📅 Tarih: ${trip.departureDate}\n` +
              `⏱️ Saat: ${trip.departureTime}\n` +
              `🔗 https://ebilet.tcddtasimacilik.gov.tr/`
          );
          await foundSearch(searchId);
        },
        onCheck: async () => {
          await bot.sendMessage(chatId, MSG.tripIsFull);
        },
        onTripExpired: async (trip) => {
          const time = typeof trip == "string" ? trip : trip.departureTime;
          await bot.sendMessage(chatId, `⏰ ${time} seferinin süresi geçti.`);
          await refreshSearchTripList(search.data._id);
        },
        onAllExpired: async () => {
          await bot.sendMessage(chatId, MSG.isTripExpired);
          await stopExpiredSearches();
        },
        onError: async (err) => {
          console.error(err);
          await bot.sendMessage(chatId, MSG.errorOccurred);
          await stopErrorSearch(search.data._id);
        },
      }
    );
  } catch (err) {
    console.error("startSearchProcess error:", err);
    await bot.sendMessage(chatId, MSG.searchFailed);
  }
}
//#endregion
