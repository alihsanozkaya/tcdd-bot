export function isValidDateFormat(dateStr) {
  return /^\d{2} \d{2} \d{4}$/.test(dateStr);
}

export function formatConfirmationMessage(fromCode, toCode, date, stations) {
  return `✅ Bilgiler alındı:
Kalkış: ${stations[fromCode]}
Varış: ${stations[toCode]}
Tarih: ${date}

🔍 Sorgu başlatılıyor...`;
}

export function parseTripText(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    trainLine: lines[0] || "🚄 Tren Bilgisi Bulunamadı",
    departureStation: lines[2] || "Kalkış ?",
    duration: lines[3] || "Süre ?",
    arrivalStation: lines[4] || "Varış ?",
    departureTime: lines[5] || "Kalkış Saati ?",
    arrivalTime: lines[6] || "Varış Saati ?",
    priceLine: lines.find((line) => line.includes("₺")) || "₺ ???",
    date: lines[7] || "Tarih ?",
    availableSeats: (() => {
      const match = text.match(/\((\d+)\)$/);
      return match ? match[1] : "?";
    })(),
  };
}

export function formatTripistItem(exp, index) {
  const {
    trainLine,
    departureStation,
    duration,
    arrivalStation,
    departureTime,
    arrivalTime,
  } = parseTripText(exp.text);

  const emoji = trainLine.startsWith("YHT")
    ? "🚅"
    : trainLine.startsWith("ANAHAT")
    ? "🚞"
    : "🚄";

  return `${index + 1}. ${emoji} ${trainLine}

  🚉 ${departureStation} → ${arrivalStation}
  🕕 ${departureTime} - ${arrivalTime} (${duration})
`;
}

export function formatActiveSearches(searches, stations, seats) {
  if (!searches.length) return "🔍 Aktif aramanız bulunmuyor.";

  let message = "🔍 Aktif Aramalarınız:\n\n";
  searches.forEach((search, i) => {
    message += `${i + 1}. ${
      stations.find((s) => s.code == search.fromStationCode).name
    } → ${stations.find((s) => s.code == search.toStationCode).name}\n`;
    message += `   📅 ${search.travelDate}\n`;
    message += `   💺 ${seats.find((s) => s._id == search.seatType).name}\n`;
    message += `   🚂 ${search.tripList.length} sefer izleniyor\n\n`;
  });
  return message;
}
