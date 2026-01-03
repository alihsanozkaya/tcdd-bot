import http from "http";
import dotenv from "dotenv";
import { startTelegramBot } from "./platforms/telegramBot.js";

dotenv.config();

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
  }
});

server.listen(process.env.PORT || 3000);

startTelegramBot();