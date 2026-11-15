import {
  getActiveSearchesByUser,
  createSearch,
  stopSearch,
  stopErrorSearch,
  getAllActiveSearches,
  foundSearch,
  preview,
} from "../services/searchService.js";
import {
  findOrCreateUser,
  getChatIdByUserId,
} from "../services/userService.js";
import * as MSG from "../utils/messages.js";
import TelegramBot from "node-telegram-bot-api";
import { getAllSteats } from "../services/seatService.js";
import { getAllStations } from "../services/stationService.js";
import {
  startApiTripChecker,
  stopApiChecker,
  isEconomyClass,
} from "../core/apiTripChecker.js";
import {
  formatActiveSearches,
  formatTripDate,
  formatTripistItem,
} from "../utils/formatter.js";

const ALLOWED_COMMANDS = ["/start", "/biletbul", "/listele", "/durdur"];

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

setInterval(
  () => {
    const now = Date.now();
    for (const [chatId, state] of tempStates) {
      if (now - state.updatedAt > STATE_TTL) tempStates.delete(chatId);
    }
  },
  5 * 60 * 1000,
);
//#endregion

//#region HELPER FUNCTIONS
const stationButtons = (stations, exclude = null) => {
  const filtered = stations.filter((s) => s.code !== exclude);
  const keyboard = [];
  for (let i = 0; i < filtered.length; i += 3) {
    keyboard.push(
      filtered.slice(i, i + 3).map((s) => ({
        text: s.name,
        callback_data: `station_${s.code}`,
      })),
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

const checkTripAvailability = async ({
  fromStationId,
  toStationId,
  travelDate,
  seatClass,
  selectedTrips,
}) => {
  try {
    const trips = await preview({
      fromStationId,
      toStationId,
      departureDate: travelDate,
    });

    if (!Array.isArray(trips) || trips.length === 0) {
      return { allFull: true, availableTrips: [], fullTrips: selectedTrips };
    }

    const availableTrips = [];
    const fullTrips = [];

    for (const selected of selectedTrips) {
      const trip = trips.find(
        (t) => Number(t.trainId) === Number(selected.trainId),
      );

      if (!trip) {
        fullTrips.push(selected);
        continue;
      }

      // checker ile aynı kural kullanılır, aksi halde ön kontrol ile
      // izleme farklı koltuk sınıfına bakabilir.
      const hasStock = isEconomyClass(seatClass)
        ? trip.economy > 0
        : trip.business > 0;

      if (hasStock) {
        availableTrips.push({ ...selected, stockInfo: trip });
      } else {
        fullTrips.push(selected);
      }
    }

    return {
      allFull: availableTrips.length === 0,
      availableTrips,
      fullTrips,
    };
  } catch (err) {
    console.error("[checkTripAvailability] Error:", err);
    throw err;
  }
};
//#endregion

//#region BOT START
export const startTelegramBot = () => {
  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
    polling: {
      interval: 3000,
      autoStart: true,
      params: {
        timeout: 20,
      },
    },
  });

  bot.on("polling_error", (err) =>
    console.error("[POLLING ERROR]", err?.message || err),
  );

  bot.on("error", (err) => console.error("[BOT ERROR]", err?.message || err));

  //#region RECOVERY LOGIC
  (async () => {
    try {
      STATIONS_CACHE = await getAllStations();
      SEATS_CACHE = await getAllSteats();

      if (!STATIONS_CACHE.length || !SEATS_CACHE.length) {
        console.error("[RECOVERY] İstasyon/koltuk listesi boş geldi");
      }

      const activeSearches = await getAllActiveSearches();

      const stationMap = new Map(STATIONS_CACHE.map((s) => [s.code, s.name]));
      const seatMap = new Map(SEATS_CACHE.map((s) => [s._id, s.name]));

      for (const search of activeSearches) {
        const chatId = await getChatIdByUserId(search.userId);

        if (!chatId) {
          console.error("[RECOVERY] chatId bulunamadı:", search._id);
          continue;
        }

        const fromName =
          stationMap.get(search.fromStationCode) ?? search.fromStationCode;
        const toName =
          stationMap.get(search.toStationCode) ?? search.toStationCode;
        const seatName = seatMap.get(search.seatType);

        if (!seatName) {
          await stopErrorSearch(search._id);
          continue;
        }

        startApiTripChecker({
          searchId: search._id,
          fromStationId: search.fromStationCode,
          toStationId: search.toStationCode,
          travelDate: search.travelDate,
          seatClass: seatName,
          selectedTrips: search.tripList,
          callbacks: {
            onFound: async (trip) => {
              await foundSearch(search._id);
              await bot.sendMessage(
                chatId,
                `🎉 YER BULUNDU!\n\n` +
                  `🚉 ${fromName} → ${toName}\n` +
                  `📅 ${formatTripDate(trip.date)}\n` +
                  `⏱️ ${trip.departure}\n` +
                  `💺 ${seatName}\n` +
                  `🔗 https://ebilet.tcddtasimacilik.gov.tr/`,
              );
            },
            onExpired: async (expiredTrips) => {
              if (!expiredTrips?.length) return;
              let msg = "⚠️ Sefer süresi geçti:\n\n";
              expiredTrips.forEach((t) => {
                msg +=
                  `🚉 ${fromName} → ${toName}\n` +
                  `📅 ${search.travelDate}\n` +
                  `⏱️ ${t.departureTime}\n\n`;
              });
              msg += "Arama durduruldu.";
              await bot.sendMessage(chatId, msg);
            },
            onError: async (err) => {
              await stopErrorSearch(search._id);
            },
          },
        });
      }
    } catch (err) {
      console.error("[RECOVERY ERROR]", err);
    }
  })();
  //#endregion

  //#region /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await findOrCreateUser(msg.from.id);
      await bot.sendMessage(chatId, MSG.startMessage);
    } catch (err) {
      console.error("[/start] Error:", err);
      bot.sendMessage(chatId, MSG.failedCreateUser);
    }
  });
  //#endregion

  //#region /biletbul
  bot.onText(/\/biletbul/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    try {
      if (!STATIONS_CACHE?.length || !SEATS_CACHE?.length) {
        return bot.sendMessage(msg.chat.id, MSG.startSystem);
      }

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
        stationButtons(STATIONS_CACHE),
      );
    } catch (err) {
      console.error("[/biletbul] Error:", err);
      bot.sendMessage(chatId, MSG.biletbulError);
    }
  });
  //#endregion

  //#region /listele
  bot.onText(/\/listele/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      if (!STATIONS_CACHE?.length || !SEATS_CACHE?.length) {
        return bot.sendMessage(chatId, MSG.startSystem);
      }

      const user = await findOrCreateUser(msg.from.id);
      const searches = await getActiveSearchesByUser(user._id);

      if (!searches.length) {
        return bot.sendMessage(chatId, MSG.noActiveSearch);
      }

      await bot.sendMessage(
        chatId,
        formatActiveSearches(searches, STATIONS_CACHE, SEATS_CACHE),
      );
    } catch (err) {
      console.error("[/listele] Error:", err);
      bot.sendMessage(chatId, MSG.listeleError);
    }
  });
  //#endregion

  //#region /durdur
  bot.onText(/\/durdur/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      if (!STATIONS_CACHE?.length) {
        return bot.sendMessage(chatId, MSG.startSystem);
      }

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
        STATIONS_CACHE.map((st) => [st.code, st.name]),
      );

      const buttons = searches.map((search, i) => {
        const fromName = stationMap.get(search.fromStationCode);
        const toName = stationMap.get(search.toStationCode);
        const times = search.tripList.map((t) => t.departureTime).join(", ");

        return [
          {
            text:
              `🛑 ${i + 1}. ${fromName} → ${toName} | ` +
              `📅 ${search.travelDate} | ` +
              `⏱️ ${times}`,
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
      console.error("[/durdur] Error:", err);
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
      if (data.startsWith("station_") && state.step === "from") {
        const from = STATIONS_CACHE.find((s) => s.code === data.split("_")[1]);
        if (!from) {
          clearState(chatId);
          return;
        }

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
          stationButtons(STATIONS_CACHE, from.code),
        );
      }

      if (data.startsWith("station_") && state.step === "to") {
        const to = STATIONS_CACHE.find((s) => s.code === data.split("_")[1]);
        if (!to) {
          clearState(chatId);
          return;
        }

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
          seatButtons(SEATS_CACHE),
        );
      }

      if (data.startsWith("seat_") && state.step === "seat") {
        const seat = SEATS_CACHE.find((s) => s._id === data.split("_")[1]);

        if (!seat) {
          clearState(chatId);
          return;
        }

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
            stopApiChecker(search._id);
            await stopSearch(search._id);
          } catch (e) {
            console.error("[stop_all] Error:", search._id, e?.message || e);
          }
        }

        clearState(chatId);

        await bot.editMessageText(MSG.allSearchStopped, {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await bot.answerCallbackQuery(query.id);
        return;
      }

      if (data === "cancel") {
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
        const search = state.searches.find(
          (s) => s._id.toString() === searchId,
        );

        if (!search) {
          clearState(chatId);
          return bot.sendMessage(chatId, MSG.searchNotFound);
        }

        stopApiChecker(searchId);
        await stopSearch(searchId);
        clearState(chatId);

        const stationMap = new Map(
          STATIONS_CACHE.map((st) => [st.code, st.name]),
        );

        const fromName = stationMap.get(search.fromStationCode);
        const toName = stationMap.get(search.toStationCode);
        const times = search.tripList.map((t) => t.departureTime).join(", ");

        await bot.editMessageText(
          `🛑 Arama durduruldu:\n\n` +
            `🚉 ${fromName} → ${toName}\n` +
            `📅 ${search.travelDate}\n` +
            `⏱️ ${times}`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
          },
        );
      }

      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error("[callback_query] Error:", err);
      bot.sendMessage(chatId, MSG.anErrorOccurred);
    }
  });
  //#endregion

  //#region MESSAGE HANDLER
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) {
      await bot.sendMessage(chatId, MSG.onlyTextCommands);
      return;
    }

    const isCommand = text.startsWith("/");
    const isAllowedCommand = ALLOWED_COMMANDS.some((cmd) =>
      text.startsWith(cmd),
    );

    const state = getState(chatId);
    if (!state && !isAllowedCommand) {
      await bot.sendMessage(chatId, MSG.invalidMessage);
      return;
    }

    if (!state && isAllowedCommand) {
      return;
    }

    try {
      if (state.step === "date") {
        if (!/^\d{2} \d{2} \d{4}$/.test(text)) {
          return bot.sendMessage(chatId, MSG.invalidDate);
        }

        const [day, month, year] = text.split(" ").map(Number);
        const inputDate = new Date(year, month - 1, day);

        if (
          inputDate.getFullYear() !== year ||
          inputDate.getMonth() !== month - 1 ||
          inputDate.getDate() !== day
        ) {
          return await bot.sendMessage(chatId, MSG.enteredAnInvalidDate);
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (inputDate < today) {
          return await bot.sendMessage(chatId, MSG.notPastDate);
        }

        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth();

        const maxDate = new Date(currentYear, currentMonth + 2, 0);
        maxDate.setHours(23, 59, 59, 999);

        if (inputDate > maxDate) {
          return await bot.sendMessage(chatId, MSG.selectMaxDate);
        }

        await bot.sendMessage(chatId, MSG.tripAreListed);

        let list;
        try {
          list = await preview({
            fromStationId: state.from,
            toStationId: state.to,
            departureDate: text,
          });
        } catch (err) {
          clearState(chatId);
          console.error("[preview error]", err?.message || err);
          return await bot.sendMessage(
            chatId,
            `⚠️ Seferler sorgulanırken hata oluştu:\n${err?.message || "TCDD servisine erişilemedi."}`,
          );
        }

        if (!list || !list.length) {
          clearState(chatId);
          return bot.sendMessage(chatId, MSG.notTripFound);
        }

        setState(chatId, {
          ...state,
          date: text,
          tripList: list,
          step: "trip",
        });

        const stationMap = new Map(STATIONS_CACHE.map((s) => [s.code, s.name]));

        let msgText = "📅 Sefer Listesi:\n\n";
        list.forEach(
          (e, i) => (msgText += formatTripistItem(e, i, stationMap) + "\n"),
        );
        msgText += "\nSefer numaralarını yazınız (örn: 1,3)";
        return bot.sendMessage(chatId, msgText);
      }

      if (state.step === "trip") {
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
          (n) => Number.isNaN(n) || n < 1 || n > state.tripList.length,
        );

        if (invalidSelections.length > 0) {
          const max = state.tripList.length;

          const rangeText =
            max === 1
              ? `Sadece 1 numaralı seferi seçebilirsiniz.`
              : `Lütfen 1 - ${max} arası değer giriniz.`;

          await bot.sendMessage(
            chatId,
            `⚠️ Geçersiz sefer numarası.\n` +
              `${rangeText}\n\n` +
              `Örnek: ${max === 1 ? "1" : "1,3"}`,
          );
          return;
        }

        const selectedTrips = selections.map((idx) => {
          const trip = state.tripList[idx - 1];
          return {
            trainId: trip.trainId,
            departureTime: trip.departure,
          };
        });

        setState(chatId, {
          ...state,
          selectedTrips,
        });

        const finished = await startSearchProcess(
          bot,
          chatId,
          getState(chatId),
        );

        if (finished) clearState(chatId);
      }
    } catch (err) {
      console.error("[message] Error:", err);
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
    if (!user?._id) {
      await bot.sendMessage(chatId, MSG.anErrorOccurred);
      return true;
    }

    const seatName = SEATS_CACHE?.find((s) => s._id === state.seatId)?.name;
    if (!seatName) {
      await bot.sendMessage(chatId, MSG.anErrorOccurred);
      return true;
    }

    const stockCheck = await checkTripAvailability({
      fromStationId: state.from,
      toStationId: state.to,
      travelDate: state.date,
      seatClass: seatName,
      selectedTrips: state.selectedTrips,
    });

    if (!stockCheck.allFull) {
      await bot.sendMessage(chatId, "🎉 Zaten boş koltuk var!");
      return true;
    }

    let search;
    try {
      search = await createSearch({
        userId: user._id,
        fromStationCode: state.from,
        toStationCode: state.to,
        seatType: state.seatId,
        travelDate: state.date,
        tripList: state.selectedTrips,
      });
    } catch (err) {
      if (err?.status === 409 || err?.response?.status === 409) {
        await bot.sendMessage(chatId, MSG.hasActiveSearch);
        return true;
      }
      throw err;
    }

    await bot.sendMessage(
      chatId,
      `🚀 Arama başlatıldı!\n\n` +
        `🚂 ${state.selectedTrips.length} sefer izleniyor\n` +
        `⏱️ Yer bulunca size buradan haber verilecektir.`,
    );

    startApiTripChecker({
      searchId: search._id,
      fromStationId: search.fromStationCode,
      toStationId: search.toStationCode,
      travelDate: search.travelDate,
      seatClass: seatName,
      selectedTrips: search.tripList,
      callbacks: {
        onFound: async (trip) => {
          await foundSearch(search._id);
          await bot.sendMessage(
            chatId,
            `🎉 YER BULUNDU!\n\n` +
              `🚉 ${state.fromName} → ${state.toName}\n` +
              `📅 ${formatTripDate(trip.date)}\n` +
              `⏱️ ${trip.departure}\n` +
              `💺 ${seatName}\n` +
              `🔗 https://ebilet.tcddtasimacilik.gov.tr/`,
          );
        },
        onExpired: async (expiredTrips) => {
          if (!expiredTrips?.length) return;
          let msg = "⚠️ Sefer süresi geçti:\n\n";
          expiredTrips.forEach((t) => {
            msg +=
              `🚉 ${state.fromName} → ${state.toName}\n` +
              `📅 ${search.travelDate}\n` +
              `⏱️ ${t.departureTime}\n\n`;
          });
          msg += "Arama durduruldu.";
          await bot.sendMessage(chatId, msg);
        },
        onError: async (err) => {
          await stopErrorSearch(search._id);
        },
      },
    });

    return true;
  } catch (err) {
    const errorText = err?.message
      ? `⚠️ İşlem sırasında hata oluştu:\n${err.message}`
      : MSG.anErrorOccurred;
    await bot.sendMessage(chatId, errorText);
    console.error("[startSearchProcess] Error:", err);
    return true;
  }
}
//#endregion
