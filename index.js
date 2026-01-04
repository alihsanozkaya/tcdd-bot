import dotenv from "dotenv";
dotenv.config();
import { startTelegramBot } from "./platforms/telegramBot.js";

startTelegramBot();