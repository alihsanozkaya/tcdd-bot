import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { startTelegramBot } from "./platforms/telegramBot.js";

startTelegramBot();

const app = express();

app.get("/", (req, res) => {
  res.status(200).send("Bot çalışıyor...");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Bot başladı ${PORT}`);
});
